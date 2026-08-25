package event

// team.go —— 门派资料与“赛事范围内出场成员名单”：并发拉门派资料/当前成员/排名候选，
// 再按每位候选在该赛区的逐场回连门派基名，统计其在本赛事范围内的出场成绩。逐场经 GamesProvider 复用选手缓存。

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"

	"huashanquery/internal/huashan"
	"huashanquery/internal/logx"
	"huashanquery/internal/player"
)

// TeamView 只暴露队伍资料与成员名单，不透传选手手机号等无关隐私字段。
type TeamView struct {
	ID         int           `json:"id"`
	Name       string        `json:"name"`
	Chief      string        `json:"chief,omitempty"`
	CreatedAt  string        `json:"created_at,omitempty"`
	UpdatedAt  string        `json:"updated_at,omitempty"`
	Season     string        `json:"season"`
	SeasonType string        `json:"season_type"`
	Zone       string        `json:"zone"`
	Members    []EventMember `json:"members"`
	Incomplete bool          `json:"incomplete,omitempty"`
}

// EventMember 是在所选赛事范围内有该门派出场记录的成员。
type EventMember struct {
	Value      string  `json:"value"`
	Label      string  `json:"label"`
	Matches    int     `json:"matches"`
	TotalPoint float64 `json:"total_point"`
	Avg        float64 `json:"avg"`
	Win        int     `json:"win"`
	MVP        int     `json:"mvp"`
	SVP        int     `json:"svp"`
	BGX        int     `json:"bgx"`
}

// EventTeam 返回门派资料，以及在指定赛区、赛季和比赛类型内有该门派出场记录的成员。
func (s *Service) EventTeam(ctx context.Context, id, season, seasonType, zone string) (*TeamView, error) {
	if !positiveNumber(id) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的门派"}
	}
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != "" && !positiveNumber(seasonType) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的比赛类型"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	teamID, _ := strconv.Atoi(id)
	var detailBody, membersBody []byte
	var detailErr, membersErr error
	var candidates map[string]string
	var rankSectName string
	var candidatesErr error
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); detailBody, detailErr = s.api.Team(ctx, id) }()
	go func() { defer wg.Done(); membersBody, membersErr = s.api.TeamMembers(ctx, id) }()
	go func() {
		defer wg.Done()
		candidates, rankSectName, candidatesErr = s.eventTeamCandidates(ctx, season, seasonType, zone, teamID)
	}()
	wg.Wait()
	if candidatesErr != nil {
		return nil, candidatesErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	team := &TeamView{
		ID: teamID, Name: rankSectName,
		Season: season, SeasonType: seasonType, Zone: zone, Members: []EventMember{},
	}
	if detailErr != nil {
		logx.Errorf("event team %d: optional team detail unavailable (%T)", teamID, detailErr)
	} else {
		var detail map[string]any
		if err := json.Unmarshal(detailBody, &detail); err != nil {
			logx.Errorf("event team %d: optional team detail contains invalid JSON: %v", teamID, err)
		} else {
			if name := stringValue(detail["name"]); name != "" {
				team.Name = name
			}
			team.Chief = chiefName(detail["chief"])
			team.CreatedAt = firstString(detail, "createTime", "create_time")
			team.UpdatedAt = firstString(detail, "updateTime", "update_time")
		}
	}

	var roster []EventOption
	if membersErr != nil {
		logx.Errorf("event team %d: optional current roster unavailable (%T)", teamID, membersErr)
	} else {
		var err error
		roster, err = decodeEventOptions(membersBody, "label")
		if err != nil {
			logx.Errorf("event team %d: optional current roster contains invalid JSON: %v", teamID, err)
			roster = nil
		}
	}

	// The settings endpoint only contains current members. Build the candidate
	// list from the scoped event aggregate so historical members who later left
	// or transferred are still included; use the current roster only to enrich
	// labels where possible.
	for _, member := range roster {
		if _, ok := candidates[member.Value]; ok && member.Label != "" {
			candidates[member.Value] = member.Label
		}
	}
	if len(candidates) == 0 {
		return team, nil
	}
	roster = make([]EventOption, 0, len(candidates))
	for value, label := range candidates {
		if label == "" {
			label = "#" + value
		}
		roster = append(roster, EventOption{Value: value, Label: label})
	}
	sort.Slice(roster, func(i, j int) bool { return roster[i].Value < roster[j].Value })

	// 出场统计按门派基名回连（逐场行只带门派名、无 sect_id）。接受两种来源的名字：门派资料名 team.Name
	// 与排名榜的门派名 rankSectName——二者偶有出入（如资料名带"俱乐部"后缀），只认其一会导致全员匹配 0 场、
	// 名单被静默清空。收成基名集合后按集合判断，任一命中即计入。
	wantSect := map[string]bool{}
	for _, n := range []string{player.BaseName(team.Name), player.BaseName(rankSectName)} {
		if n != "" {
			wantSect[n] = true
		}
	}

	seasonID, _ := strconv.Atoi(season)
	typeID, _ := strconv.Atoi(seasonType)
	jobs := make(chan EventOption)
	results := make(chan EventMember, len(roster))
	var incomplete bool
	var firstFetchErr error
	checked := 0
	var resultMu sync.Mutex
	workerCount := min(8, len(roster))
	var workers sync.WaitGroup
	for range workerCount {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for member := range jobs {
				games, fetchErr := s.games.ZoneGames(ctx, member.Value, zone)
				if fetchErr != nil {
					resultMu.Lock()
					incomplete = true
					if firstFetchErr == nil {
						firstFetchErr = fetchErr
					}
					resultMu.Unlock()
					continue
				}
				resultMu.Lock()
				checked++
				resultMu.Unlock()
				var matches, wins, mvp, svp, bgx int
				var totalPoint float64
				for _, game := range games {
					if game.HasSeason && game.SeasonID == seasonID && game.SectBase != "" && wantSect[game.SectBase] &&
						(typeID == 0 || game.SeasonTypeID == typeID) {
						matches++
						totalPoint += game.Point
						if game.Win {
							wins++
						}
						if game.MVP {
							mvp++
						}
						if game.SVP {
							svp++
						}
						if game.BGX {
							bgx++
						}
					}
				}
				if matches > 0 {
					results <- EventMember{
						Value: member.Value, Label: member.Label, Matches: matches,
						TotalPoint: player.Round2(totalPoint), Avg: player.Round2(totalPoint / float64(matches)),
						Win: int(math.Round(float64(wins) / float64(matches) * 100)),
						MVP: mvp, SVP: svp, BGX: bgx,
					}
				}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, member := range roster {
			select {
			case jobs <- member:
			case <-ctx.Done():
				return
			}
		}
	}()
	workers.Wait()
	close(results)
	if checked == 0 && firstFetchErr != nil {
		return nil, firstFetchErr
	}
	for member := range results {
		team.Members = append(team.Members, member)
	}
	team.Incomplete = incomplete
	// 有候选、逐场也读到了，却没人匹配上门派名——多半是门派名与逐场里的门派基名不一致（回连键失效）。
	// 记一条带上下文的日志，便于定位这类静默空名单（页面仍正常显示"暂无出场成员"）。
	if len(team.Members) == 0 && checked > 0 && len(roster) > 0 {
		keys := make([]string, 0, len(wantSect))
		for k := range wantSect {
			keys = append(keys, k)
		}
		logx.Errorf("event team %d (%q): %d candidate(s) but 0 games matched sect base names %v (per-game sect name likely differs)", teamID, team.Name, len(roster), keys)
	}
	sort.SliceStable(team.Members, func(i, j int) bool {
		if team.Members[i].TotalPoint != team.Members[j].TotalPoint {
			return team.Members[i].TotalPoint > team.Members[j].TotalPoint
		}
		if team.Members[i].Matches != team.Members[j].Matches {
			return team.Members[i].Matches > team.Members[j].Matches
		}
		return team.Members[i].Label < team.Members[j].Label
	})
	return team, nil
}

// eventTeamCandidates returns every scoped player whose membership list contains
// the selected sect. Per-game records later confirm the event-specific sect, so
// transferred historical participants remain discoverable without guessing from
// membership order.
func (s *Service) eventTeamCandidates(ctx context.Context, season, seasonType, zone string, teamID int) (map[string]string, string, error) {
	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, "", err
	}
	teamIndex := make(map[int]int, len(rankings.Items))
	for i, rank := range rankings.Items {
		teamIndex[rank.SectID] = i
	}
	targetIndex, exists := teamIndex[teamID]
	if !exists {
		return nil, "", &huashan.APIError{Status: http.StatusBadRequest, Message: "当前赛事中没有这个门派"}
	}
	sectName := rankings.Items[targetIndex].SectName

	candidates := make(map[string]string)
	for page := 1; page <= eventMaxPages; page++ {
		metricPage, pageErr := s.EventSectRankMetricPage(ctx, season, seasonType, zone, page)
		if pageErr != nil {
			return nil, "", pageErr
		}
		for _, pa := range metricPage.players {
			if pa.PlayerID <= 0 || !eventPlayerMatchesSect(teamIndex, targetIndex, pa) {
				continue
			}
			id := strconv.Itoa(pa.PlayerID)
			if label := pa.label(); label != "" || candidates[id] == "" {
				candidates[id] = label
			}
		}
		if metricPage.TotalPages > eventMaxPages {
			return nil, "", &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛成员数据过多，无法完整读取"}
		}
		if metricPage.TotalPages > 0 {
			if page >= metricPage.TotalPages {
				break
			}
		} else if !metricPage.HasMore {
			break
		}
		if page == eventMaxPages {
			return nil, "", &huashan.APIError{Status: http.StatusBadGateway, Message: "参赛成员数据过多，无法完整读取"}
		}
	}
	return candidates, sectName, nil
}

func chiefName(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case map[string]any:
		for _, key := range []string{"name", "nickname", "label"} {
			if s := stringValue(x[key]); s != "" {
				return s
			}
		}
	}
	return ""
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s := stringValue(m[key]); s != "" {
			return s
		}
	}
	return ""
}

func stringValue(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
