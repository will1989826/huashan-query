package event

// group_draw.go - build the seeded order used by the four-group draw simulator.

import (
	"context"
	"math"
	"net/http"
	"sort"

	"huashanquery/internal/huashan"
)

const (
	challengerSeasonType = "2"
	regularSeasonType    = "3"
)

type GroupDrawTool struct {
	Season     string          `json:"season"`
	SeasonType string          `json:"season_type"`
	Zone       string          `json:"zone"`
	Teams      []GroupDrawTeam `json:"teams"`
}

type GroupDrawTeam struct {
	Rank       int     `json:"rank"`
	SectID     int     `json:"sect_id"`
	SectName   string  `json:"sect_name"`
	TotalPoint float64 `json:"total_point"`
	MVP        int     `json:"mvp"`
	SVP        int     `json:"svp"`
	BGX        int     `json:"bgx"`
}

// EventGroupDraw builds one competition's seeded order.
func (s *Service) EventGroupDraw(ctx context.Context, season, seasonType, zone string) (*GroupDrawTool, error) {
	if !positiveNumber(season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择赛季"}
	}
	if seasonType != challengerSeasonType && seasonType != regularSeasonType {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "分组模拟仅支持踢馆赛和常规赛"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) || zone == "ALL" {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}

	rankings, err := s.EventSectRankings(ctx, season, seasonType, zone)
	if err != nil {
		return nil, err
	}
	if len(rankings.Items) == 0 {
		return nil, &huashan.APIError{Status: http.StatusUnprocessableEntity, Message: "该赛事没有门派排名数据，暂时无法分组"}
	}
	teams := make([]GroupDrawTeam, 0, len(rankings.Items))
	for _, rank := range rankings.Items {
		teams = append(teams, GroupDrawTeam{
			SectID: rank.SectID, SectName: rank.SectName, TotalPoint: rank.TotalPoint,
			MVP: rank.MVP, SVP: rank.SVP, BGX: rank.BGX,
		})
	}
	rankGroupDrawTeams(teams)
	return &GroupDrawTool{Season: season, SeasonType: seasonType, Zone: zone, Teams: teams}, nil
}

func rankGroupDrawTeams(teams []GroupDrawTeam) {
	sort.SliceStable(teams, func(i, j int) bool {
		a, b := teams[i], teams[j]
		if math.Abs(a.TotalPoint-b.TotalPoint) > drawTolerance {
			return a.TotalPoint > b.TotalPoint
		}
		if a.MVP != b.MVP {
			return a.MVP > b.MVP
		}
		if a.SVP != b.SVP {
			return a.SVP > b.SVP
		}
		if a.BGX != b.BGX {
			return a.BGX < b.BGX
		}
		return a.SectID < b.SectID
	})
	for i := range teams {
		teams[i].Rank = i + 1
	}
}
