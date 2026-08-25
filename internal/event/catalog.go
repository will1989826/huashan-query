package event

// catalog.go —— 赛事资料字典与“真实数据范围”探测：赛季/比赛类型/赛区下拉、以及按赛区+赛季核对实际有数据的可选范围。

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"huashanquery/internal/huashan"
)

// EventOption 是赛事资料里的一个官方选项。Value 始终转成字符串，兼容官方字典混用数字和字符串。
type EventOption struct {
	Value    string `json:"value"`
	Label    string `json:"label"`
	Ordering int    `json:"ordering,omitempty"`
	Camp     int    `json:"camp,omitempty"`
}

// EventCatalog 汇总赛事筛选与牌局资料字典。
type EventCatalog struct {
	Seasons     []EventOption `json:"seasons"`
	SeasonTypes []EventOption `json:"season_types"`
	Zones       []EventOption `json:"zones"`
	Editions    []EventOption `json:"editions"`
	Roles       []EventOption `json:"roles"`
}

// EventAvailability 是当前赛季和赛区下，实际存在门派排名数据的可选范围。
type EventAvailability struct {
	Seasons     []EventOption `json:"seasons"`
	SeasonTypes []EventOption `json:"season_types"`
	Zones       []EventOption `json:"zones"`
}

// EventSeasonRange 是一个赛区实际存在排名数据的赛季范围。
type EventSeasonRange struct {
	Zone    string        `json:"zone"`
	Seasons []EventOption `json:"seasons"`
}

// EventSeasonsForZone 用每季一条的小请求确定该赛区实际可选的赛季，并缓存探测结果。
func (s *Service) EventSeasonsForZone(ctx context.Context, zone string) (*EventSeasonRange, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	probes := make(map[string]eventProbe, len(catalog.Seasons))
	for _, option := range catalog.Seasons {
		probe := eventProbe{season: option.Value, zone: zone}
		probes[eventProbeKey(probe)] = probe
	}
	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}
	seasons := make([]EventOption, 0, len(catalog.Seasons))
	for _, option := range catalog.Seasons {
		if available[eventProbeKey(eventProbe{season: option.Value, zone: zone})] {
			seasons = append(seasons, option)
		}
	}
	return &EventSeasonRange{Zone: zone, Seasons: seasons}, nil
}

// EventSeasonTypesForScope 只探测指定赛区+赛季实际有数据的比赛类型，供筛选器的“比赛类型”下拉按需刷新。
// 与 EventAvailability 不同，这里不连带探测其它赛区/赛季——避免为了一个下拉多发约 20 个无关请求、
// 也避免任一无关赛区探测失败把整个比赛类型下拉一起拖垮。探测结果按组合缓存，复用 EventAvailability 的缓存池。
func (s *Service) EventSeasonTypesForScope(ctx context.Context, season, zone string) ([]EventOption, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if !eventOptionExists(catalog.Seasons, season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛季"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}
	probes := make(map[string]eventProbe, len(catalog.SeasonTypes))
	for _, option := range catalog.SeasonTypes {
		probe := eventProbe{season: season, seasonType: option.Value, zone: zone}
		probes[eventProbeKey(probe)] = probe
	}
	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}
	types := make([]EventOption, 0, len(catalog.SeasonTypes))
	for _, option := range catalog.SeasonTypes {
		if available[eventProbeKey(eventProbe{season: season, seasonType: option.Value, zone: zone})] {
			types = append(types, option)
		}
	}
	return types, nil
}

// EventsCatalog 只读取排名筛选立即需要的赛季和比赛类型；版型与身份留到需要牌局资料时再取。
func (s *Service) EventsCatalog(ctx context.Context) (*EventCatalog, error) {
	s.mu.Lock()
	if s.catalog != nil {
		v := s.catalog
		s.mu.Unlock()
		return v, nil
	}
	s.mu.Unlock()

	var bodies [2][]byte
	var errs [2]error
	fetches := []func(context.Context) ([]byte, error){s.api.EventSeasons, s.api.EventSeasonTypes}
	var wg sync.WaitGroup
	for i, fetch := range fetches {
		wg.Add(1)
		go func(i int, fetch func(context.Context) ([]byte, error)) {
			defer wg.Done()
			bodies[i], errs[i] = fetch(ctx)
		}(i, fetch)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}

	seasons, err := decodeEventOptions(bodies[0], "text")
	if err != nil {
		return nil, eventDecodeError(err)
	}
	types, err := decodeEventOptions(bodies[1], "text")
	if err != nil {
		return nil, eventDecodeError(err)
	}
	v := &EventCatalog{Seasons: seasons, SeasonTypes: types, Zones: zoneOptions(), Editions: []EventOption{}, Roles: []EventOption{}}
	s.mu.Lock()
	if s.catalog == nil {
		s.catalog = v
	} else {
		v = s.catalog
	}
	s.mu.Unlock()
	return v, nil
}

func decodeEventOptions(body []byte, labelKey string) ([]EventOption, error) {
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	out := make([]EventOption, 0, len(rows))
	for _, row := range rows {
		var deleted bool
		_ = json.Unmarshal(row["deleted"], &deleted)
		if deleted {
			continue
		}
		label := rawString(row[labelKey])
		value := rawString(row["value"])
		if label == "" || value == "" {
			continue
		}
		var ordering, camp int
		_ = json.Unmarshal(row["ordering"], &ordering)
		_ = json.Unmarshal(row["camp"], &camp)
		out = append(out, EventOption{Value: value, Label: label, Ordering: ordering, Camp: camp})
	}
	return out, nil
}

func rawString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

type eventProbe struct {
	season, seasonType, zone string
}

// EventAvailability 用小页请求核对真实数据范围；结果按组合缓存到程序退出，避免切换筛选时重复探测。
func (s *Service) EventAvailability(ctx context.Context, season, zone string) (*EventAvailability, error) {
	catalog, err := s.EventsCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if !eventOptionExists(catalog.Seasons, season) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛季"}
	}
	zone = zoneOrDefault(zone)
	if !validZone(zone) {
		return nil, &huashan.APIError{Status: http.StatusBadRequest, Message: "请选择有效的赛区"}
	}

	probes := make(map[string]eventProbe)
	add := func(p eventProbe) { probes[eventProbeKey(p)] = p }
	for _, option := range catalog.Seasons {
		add(eventProbe{season: option.Value, zone: zone})
	}
	for _, option := range catalog.Zones {
		add(eventProbe{season: season, zone: option.Value})
	}
	for _, option := range catalog.SeasonTypes {
		add(eventProbe{season: season, seasonType: option.Value, zone: zone})
	}

	available, err := s.resolveEventAvailability(ctx, probes)
	if err != nil {
		return nil, err
	}

	filter := func(options []EventOption, probe func(EventOption) eventProbe) []EventOption {
		out := make([]EventOption, 0, len(options))
		for _, option := range options {
			if available[eventProbeKey(probe(option))] {
				out = append(out, option)
			}
		}
		return out
	}
	return &EventAvailability{
		Seasons: filter(catalog.Seasons, func(option EventOption) eventProbe {
			return eventProbe{season: option.Value, zone: zone}
		}),
		Zones: filter(catalog.Zones, func(option EventOption) eventProbe {
			return eventProbe{season: season, zone: option.Value}
		}),
		SeasonTypes: filter(catalog.SeasonTypes, func(option EventOption) eventProbe {
			return eventProbe{season: season, seasonType: option.Value, zone: zone}
		}),
	}, nil
}

func (s *Service) resolveEventAvailability(ctx context.Context, probes map[string]eventProbe) (map[string]bool, error) {
	available := make(map[string]bool, len(probes))
	missing := make([]eventProbe, 0, len(probes))
	s.mu.Lock()
	for key, probe := range probes {
		if value, ok := s.availability[key]; ok {
			available[key] = value
		} else {
			missing = append(missing, probe)
		}
	}
	s.mu.Unlock()

	if len(missing) > 0 {
		jobs := make(chan eventProbe, len(missing))
		type probeResult struct {
			probe eventProbe
			has   bool
			err   error
		}
		results := make(chan probeResult, len(missing))
		for _, probe := range missing {
			jobs <- probe
		}
		close(jobs)
		var workers sync.WaitGroup
		for range min(6, len(missing)) {
			workers.Add(1)
			go func() {
				defer workers.Done()
				for probe := range jobs {
					has, probeErr := s.probeEventAvailability(ctx, probe)
					results <- probeResult{probe: probe, has: has, err: probeErr}
				}
			}()
		}
		workers.Wait()
		close(results)
		var firstErr error
		for result := range results {
			if result.err != nil {
				if firstErr == nil {
					firstErr = result.err
				}
				continue
			}
			key := eventProbeKey(result.probe)
			available[key] = result.has
			s.mu.Lock()
			s.availability[key] = result.has
			s.mu.Unlock()
		}
		if firstErr != nil {
			return nil, firstErr
		}
	}
	return available, nil
}

func eventOptionExists(options []EventOption, value string) bool {
	for _, option := range options {
		if option.Value == value {
			return true
		}
	}
	return false
}

func eventProbeKey(probe eventProbe) string {
	return probe.season + "|" + probe.seasonType + "|" + probe.zone
}

func (s *Service) probeEventAvailability(ctx context.Context, probe eventProbe) (bool, error) {
	body, err := s.api.SectStats(ctx, probe.season, probe.seasonType, probe.zone, 1, 1)
	if err != nil {
		return false, err
	}
	var data struct {
		Items      []json.RawMessage `json:"items"`
		TotalItems *int              `json:"total_items"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return false, eventDecodeError(err)
	}
	return len(data.Items) > 0 || (data.TotalItems != nil && *data.TotalItems > 0), nil
}
