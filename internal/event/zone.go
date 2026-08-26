package event

// zone.go —— 赛区(zone)的唯一事实源。赛事页赛区下拉、赛区校验与默认全部据此；
// 新增/调整赛区只改本文件的 eventZones，其余处经 zoneOptions/validZone/zoneOrDefault 复用，不再散落硬编码。

const defaultZone = "SH" // 赛事筛选未指定赛区时的默认赛区（上海）。

// DefaultZoneCode 供服务装配层启动后台预热时复用赛事默认赛区。
func DefaultZoneCode() string { return defaultZone }

// eventZones 是官方赛区代码与中文名的权威清单（顺序即下拉展示顺序，SH 居首）。
var eventZones = []EventOption{
	{Value: "SH", Label: "上海赛区"}, {Value: "BJ", Label: "北京赛区"},
	{Value: "HSXM", Label: "厦门赛区"}, {Value: "HSGZ", Label: "广州赛区"},
	{Value: "HSHZ", Label: "杭州赛区"}, {Value: "SD", Label: "山东赛区"},
	{Value: "WH", Label: "武汉赛区"}, {Value: "CQ", Label: "重庆赛区"},
	{Value: "NJ", Label: "南京赛区"}, {Value: "HF", Label: "安徽赛区"},
	{Value: "CS", Label: "长沙赛区"}, {Value: "XA", Label: "西安赛区"},
	{Value: "NC", Label: "南昌赛区"}, {Value: "RANK", Label: "杭州 Rank"},
	{Value: "HSYXS", Label: "华山英雄赛"}, {Value: "HZYC", Label: "杭州羊村英雄赛"},
	{Value: "GZHSYXS", Label: "广州华山英雄赛"}, {Value: "HZHSYXS", Label: "杭州英雄赛"},
	{Value: "HSGRS", Label: "华山个人赛"}, {Value: "SDGRS", Label: "山东个人赛"},
}

// zoneOptions 返回赛区下拉选项（赛事资料字典 catalog.Zones 用）。
func zoneOptions() []EventOption { return eventZones }

// validZone 判定赛区代码是否为有效赛区（不含 ALL——赛事排名恒按具体赛区）。
func validZone(code string) bool { return eventOptionExists(eventZones, code) }

// zoneOrDefault 空赛区回落到默认赛区，否则原样返回。
func zoneOrDefault(code string) string {
	if code == "" {
		return defaultZone
	}
	return code
}
