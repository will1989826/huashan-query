// Package event 是选手详情之上的“赛事聚合层”：门派排名、参赛量换算、门派成员名单与赛事资料字典。
// 它单向依赖 player（复用逐场解析 player.Game、门派基名 player.BaseName、四舍五入 player.Round2，
// 以及经 GamesProvider 复用选手逐场的同一份 LRU/内存预算缓存）与 huashan（官方接口）；player 不反向依赖本包。
// 赛区(zone)是本层的领域概念：唯一事实源在 zone.go，校验/默认全部据此。
package event

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"huashanquery/internal/huashan"
	"huashanquery/internal/player"
)

// GamesProvider 提供“某选手某赛区已解析逐场”，由 player.Service 实现。经它读取的逐场与选手详情
// 共享同一份缓存与内存预算：门派成员统计、归属补查按选手+赛区读取时零重复拉取、总量有界。
type GamesProvider interface {
	ZoneGames(ctx context.Context, id, zone string) ([]player.Game, error)
	EventGames(ctx context.Context, id, zone, season, seasonType string) ([]player.Game, error)
}

// Service 是赛事服务：持有官方客户端、逐场提供者，以及赛事资料/可用性/排名/分页/门派归属等按需缓存。
// 缓存不设时间过期，只随进程存续；关掉重开即最新（与 player 层一致）。
type Service struct {
	api   *huashan.Client
	games GamesProvider

	mu           sync.Mutex
	catalog      *EventCatalog
	availability map[string]bool
	rankings     map[string]*EventRankings
	metricPages  map[string]*EventRankMetricPage
	playerSect   map[string]string // 赛事归属缓存：季|赛区|选手 → 最新一场门派基名（歧义补查结果，值很小）
	drawTools    map[string]*DrawTool
	drawCalls    map[string]*drawToolCall
}

// New 构造赛事服务。api 为官方客户端（与 player 复用同一实例），games 为逐场提供者（通常即 player.Service）。
func New(api *huashan.Client, games GamesProvider) *Service {
	return &Service{
		api: api, games: games,
		availability: make(map[string]bool),
		rankings:     make(map[string]*EventRankings),
		metricPages:  make(map[string]*EventRankMetricPage),
		playerSect:   make(map[string]string),
		drawTools:    make(map[string]*DrawTool),
		drawCalls:    make(map[string]*drawToolCall),
	}
}

func is401(err error) bool {
	ae, ok := err.(*huashan.APIError)
	return ok && ae.Status == 401
}

// jsonNum 兼容 数字 / 字符串数字 / null 的数值字段（官方接口偶尔用字符串装数字），与 player 层同口径。
// 非数字内容按“未设置”容错，不使整条解析失败。
type jsonNum struct {
	v   float64
	set bool
}

func (n *jsonNum) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		return nil
	}
	s = strings.Trim(s, `"`)
	if s == "" {
		return nil
	}
	switch s {
	case "true":
		n.v, n.set = 1, true
		return nil
	case "false":
		n.v, n.set = 0, true
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	n.v, n.set = f, true
	return nil
}

func positiveNumber(s string) bool {
	if s == "" {
		return false
	}
	n, err := strconv.Atoi(s)
	return err == nil && n > 0
}

func eventDecodeError(err error) error {
	return &huashan.APIError{Status: http.StatusBadGateway, Message: "赛事数据解析失败：" + err.Error()}
}
