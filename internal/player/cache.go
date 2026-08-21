// cache.go —— 选手级内存缓存：按选手 LRU（访问即刷新序号，超容量顶掉最久未访问者）。
// 不设时间过期：没人会一直挂着这个程序，数据只随人数上限被顶替；关掉重开即拿最新。
// 单选手内对同一子键做 singleflight，合并并发请求，只真正拉取一次。
package player

import (
	"context"
	"sync"
	"time"
)

const (
	defaultCacheCap     = 100
	defaultGamesBudget  = 120000 // 缓存的原始逐场总条数“软预算”（≈ 6 名满配 2 万场重度选手）；见 enforceBudget 的边界说明
	maxSubsPerPlayer    = 48     // 单选手子键(games|zone、stats|zone|season)数量上限，超出按 LRU 顶掉最久未用的已就绪子项
	defaultGameCacheCap = 256    // 缓存“已分析单局字节”的局数上限（每局约 6–16KB，256 局约数 MB）；超出按 LRU 顶替
)

// 共享后台拉取的时长上限。拉取不再继承任一页面请求的取消信号（切换赛季/门派会取消旧请求，若共享同一子键
// 会把取消传染给新请求，见下方 getSub），改用独立的带超时后台 context；等待者各自按自己的 ctx 提前离场。
const (
	subFetchBudget  = 3 * time.Minute  // stats/逐场索引后台拉取上限（重度选手逐场需拉多页，给足余量）
	gameFetchBudget = 45 * time.Second // 单局后台拉取上限
)

// entry 是一次子数据拉取（singleflight）：ready 关闭后 val/err 就绪。成功即长期复用，直到该选手被 LRU 顶掉。
// done 是锁保护的完成标志（淘汰判定看它、不看 ready 是否关闭，杜绝“完成/关闭”时序漏洞）；
// refs 是在场等待者数、cancel 取消后台拉取：最后一个等待者离开且未完成 → 取消拉取并删除（见 leaveSub）。
type entry struct {
	ready  chan struct{}
	val    any
	err    error
	access uint64 // 最近访问序号（单调递增，用于子键级 LRU）
	done   bool   // 完成标志（锁保护）
	refs   int    // 在场等待者数（锁保护）
	cancel context.CancelFunc
}

// playerCache 持有单个选手的各子数据（games|zone、stats|zone|season）与最近访问序号。
type playerCache struct {
	mu     sync.Mutex
	subs   map[string]*entry
	seq    uint64 // 子键访问计数器（单调递增，用于子键级 LRU）
	access uint64 // 最近访问序号（单调递增，用于选手级 LRU；避免依赖时钟分辨率）
}

type store struct {
	mu     sync.Mutex
	ps     map[string]*playerCache
	seq    uint64 // 全局访问计数器
	cap    int
	budget int // 缓存的原始逐场总条数上限
}

func newStore(capacity int) *store {
	if capacity <= 0 {
		capacity = defaultCacheCap
	}
	return &store{ps: map[string]*playerCache{}, cap: capacity, budget: defaultGamesBudget}
}

// player 取得（或新建）某选手的缓存并刷新其访问序号；超人数上限或超战绩条数预算时顶掉最久未访问者。
func (s *store) player(id string) *playerCache {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.ps[id]
	if p == nil {
		if len(s.ps) >= s.cap {
			s.evictOldestExcept(nil)
		}
		p = &playerCache{subs: map[string]*entry{}}
		s.ps[id] = p
	}
	s.seq++
	p.access = s.seq
	s.enforceBudget(p)
	return p
}

// enforceBudget 在总战绩条数超预算时，按 LRU 顶掉选手（保留当前 keep，避免顶掉正在用的）。
// 这是“软预算”：只在缓存有 >1 名选手时回收，且永远保留当前选手——单个（或当前）重度选手自身超预算时不生效。
// 之所以可接受：单个索引已被 gamesMaxPage(=2 万场)硬性封顶，远低于预算，故软预算只用于跨选手的总量回收。
// 结算时机：每次 player() 访问都重查；此外，逐场拉取只要真正完成入缓存，就必然有一个在场的 Detail 调用方
// （否则引用计数归零、拉取会被取消不入缓存），该调用方在 wg.Wait() 后必调 enforceBudgetNow——故“完成即结算”成立。
// 最坏内存由“选手数上限 × 单索引封顶”兜底。
func (s *store) enforceBudget(keep *playerCache) {
	for len(s.ps) > 1 {
		total := 0
		for _, p := range s.ps {
			total += p.gameCount()
		}
		if total <= s.budget {
			return
		}
		if !s.evictOldestExcept(keep) {
			return
		}
	}
}

// enforceBudgetNow 加锁后重查预算。逐场是在 player() 之后才异步拉取写入的，所以拉取完成后需再查一次，
// 否则并发拉多个重度选手时总量会持续超预算而不被回收（保留当前 keep，避免顶掉正在展示的选手）。
func (s *store) enforceBudgetNow(keep *playerCache) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enforceBudget(keep)
}

// evictOldestExcept 顶掉 access 序号最小（最久未访问）的选手，keep 除外。返回是否顶掉了一个。
func (s *store) evictOldestExcept(keep *playerCache) bool {
	var oldestID string
	var oldest uint64
	for id, p := range s.ps {
		if p == keep {
			continue
		}
		if oldestID == "" || p.access < oldest {
			oldestID, oldest = id, p.access
		}
	}
	if oldestID == "" {
		return false
	}
	delete(s.ps, oldestID)
	return true
}

// len 返回当前缓存的选手数（测试用）。
func (s *store) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.ps)
}

// gameCount 汇总该选手已缓存的逐场条数（只数已完成且成功的 games 索引）。
func (p *playerCache) gameCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	n := 0
	for _, e := range p.subs {
		if e.done && e.err == nil { // 在途：暂不计入
			if gi, ok := e.val.(*gameIndex); ok {
				n += len(gi.games)
			}
		}
	}
	return n
}

// getSub 取子数据：命中且成功则长期复用；有在途拉取则搭车等待；否则起一次后台拉取并缓存（错误不缓存）。
// 拉取跑在独立后台 context 上，调用方(ctx)取消只让“自己”离场返回 ctx.Err()，不把取消传染给同键其他等待者；
// 但用引用计数兜底：当最后一个等待者也离开、拉取仍未完成时，取消该后台拉取并删除（避免切换选手/赛区后
// 孤儿重任务成倍堆积、争抢带宽触发 429）。见 leaveSub。
func (p *playerCache) getSub(ctx context.Context, key string, fetch func(context.Context) (any, error)) (any, error) {
	p.mu.Lock()
	e := p.subs[key]
	if e != nil && e.done {
		if e.err == nil { // 命中成功：长期复用
			p.seq++
			e.access = p.seq
			p.mu.Unlock()
			return e.val, nil
		}
		e = nil // 失败项通常已删；保险起见按未命中处理
	}
	if e == nil { // 无在途/未命中：起一次后台拉取
		e = &entry{ready: make(chan struct{})}
		p.seq++
		e.access = p.seq
		p.subs[key] = e
		p.evictSubsLocked(key)
		fctx, cancel := context.WithTimeout(context.Background(), subFetchBudget)
		e.cancel = cancel
		go p.runSub(key, e, fctx, fetch)
	}
	e.refs++ // 登记为等待者
	p.mu.Unlock()

	var cerr error
	select {
	case <-e.ready:
	case <-ctx.Done():
		cerr = ctx.Err()
	}
	p.leaveSub(key, e)
	if cerr != nil {
		return nil, cerr
	}
	return e.val, e.err
}

// runSub 执行一次后台拉取：完成状态在锁内发布（done=true）后再关闭 ready——淘汰按 done 判定，
// 这样多任务同时完成时，先获锁者会把已完成的其他项正确视为“可淘汰”，不会互相误判在途而永久超上限。
func (p *playerCache) runSub(key string, e *entry, fctx context.Context, fetch func(context.Context) (any, error)) {
	val, err := fetch(fctx)
	if e.cancel != nil {
		e.cancel()
	}
	p.mu.Lock()
	e.val, e.err, e.done = val, err, true
	if err != nil { // 失败不缓存，便于重试
		if p.subs[key] == e {
			delete(p.subs, key)
		}
	} else {
		p.evictSubsLocked(key) // 完成后在锁内再淘汰一次：并发插入时插入期都在途、无从淘汰，就绪后补齐硬上限
	}
	p.mu.Unlock()
	close(e.ready)
}

// leaveSub 等待者离场：引用计数减一；若归零且拉取尚未完成，取消后台拉取并删除该 flight（下次请求重来）。
func (p *playerCache) leaveSub(key string, e *entry) {
	p.mu.Lock()
	e.refs--
	if e.refs == 0 && !e.done {
		if e.cancel != nil {
			e.cancel()
		}
		if p.subs[key] == e {
			delete(p.subs, key)
		}
	}
	p.mu.Unlock()
}

// evictSubsLocked 在子键数超上限时，顶掉最久未用的“已就绪”子项（在途的有等待者，不动；keepKey 除外）。
// 调用者须持有 p.mu。这样单选手在多赛区/赛季间反复切换时，子键与其缓存的逐场索引都有界，
// 不会绕过选手数上限与逐场总预算无限累积。
func (p *playerCache) evictSubsLocked(keepKey string) {
	for len(p.subs) > maxSubsPerPlayer {
		oldestKey, oldest := "", uint64(0)
		for k, e := range p.subs {
			if k == keepKey || !e.done { // keepKey 与未完成项(在途/有等待者)不淘汰
				continue
			}
			if oldestKey == "" || e.access < oldest {
				oldestKey, oldest = k, e.access
			}
		}
		if oldestKey == "" { // 其余都在途：暂不淘汰
			return
		}
		delete(p.subs, oldestKey)
	}
}

// —— 单局缓存（按 gid LRU）——
// 单局“已分析字节”与选手/作用域无关，只按 gid 缓存：同一局无论谁看、从哪个详情进都复用。
// 与选手缓存一致：不设时间过期，只随局数上限被顶替；关掉重开即拿最新。悬停预取与点击打开会并发命中同一
// gid，靠 singleflight 合并，只真正拉取+分析一次。

// gameEntry 是一局的拉取+分析结果（singleflight）。字段语义同 entry：done 锁保护完成标志（淘汰判定用）、
// refs 等待者数、cancel 取消后台拉取（最后一个等待者离开且未完成则取消并删除）。
type gameEntry struct {
	ready  chan struct{}
	val    []byte
	err    error
	access uint64 // 最近访问序号（单调递增，用于 LRU）
	done   bool
	refs   int
	cancel context.CancelFunc
}

type gameStore struct {
	mu  sync.Mutex
	m   map[string]*gameEntry
	seq uint64 // 全局访问计数器
	cap int
}

func newGameStore(capacity int) *gameStore {
	if capacity <= 0 {
		capacity = defaultGameCacheCap
	}
	return &gameStore{m: map[string]*gameEntry{}, cap: capacity}
}

// get 取某局的已分析字节：命中且成功则复用；有在途拉取则搭车等待；否则起一次后台拉取并缓存（错误不缓存）。
// 与 getSub 同理：后台 context + 完成状态锁内发布 + 等待者引用计数（最后一个离开且未完成则取消），
// 悬停预取与点击打开搭同一 gid 的车不互相污染，取消预取也不会留下孤儿拉取。
func (gs *gameStore) get(ctx context.Context, gid string, fetch func(context.Context) ([]byte, error)) ([]byte, error) {
	gs.mu.Lock()
	e := gs.m[gid]
	if e != nil && e.done {
		if e.err == nil {
			gs.seq++
			e.access = gs.seq
			gs.mu.Unlock()
			return e.val, nil
		}
		e = nil
	}
	if e == nil {
		e = &gameEntry{ready: make(chan struct{})}
		gs.seq++
		e.access = gs.seq
		gs.m[gid] = e
		gs.evictLocked(gid)
		fctx, cancel := context.WithTimeout(context.Background(), gameFetchBudget)
		e.cancel = cancel
		go gs.run(gid, e, fctx, fetch)
	}
	e.refs++
	gs.mu.Unlock()

	var cerr error
	select {
	case <-e.ready:
	case <-ctx.Done():
		cerr = ctx.Err()
	}
	gs.leave(gid, e)
	if cerr != nil {
		return nil, cerr
	}
	return e.val, e.err
}

// run 执行一次后台拉取；完成状态在锁内发布(done)后再关闭 ready（淘汰按 done 判定，杜绝完成/关闭时序漏洞）。
func (gs *gameStore) run(gid string, e *gameEntry, fctx context.Context, fetch func(context.Context) ([]byte, error)) {
	val, err := fetch(fctx)
	if e.cancel != nil {
		e.cancel()
	}
	gs.mu.Lock()
	e.val, e.err, e.done = val, err, true
	if err != nil { // 失败不缓存，便于重试
		if gs.m[gid] == e {
			delete(gs.m, gid)
		}
	} else {
		gs.evictLocked(gid) // 完成后在锁内再淘汰一次：补齐硬上限
	}
	gs.mu.Unlock()
	close(e.ready)
}

// leave 等待者离场：引用计数减一；归零且未完成则取消后台拉取并删除（下次请求重来）。
func (gs *gameStore) leave(gid string, e *gameEntry) {
	gs.mu.Lock()
	e.refs--
	if e.refs == 0 && !e.done {
		if e.cancel != nil {
			e.cancel()
		}
		if gs.m[gid] == e {
			delete(gs.m, gid)
		}
	}
	gs.mu.Unlock()
}

// evictLocked 在局数超上限时，顶掉最久未访问的“已完成”项（未完成的有等待者/在途，不动；keep 除外）。调用者须持 gs.mu。
func (gs *gameStore) evictLocked(keep string) {
	for len(gs.m) > gs.cap {
		oldestKey, oldest := "", uint64(0)
		for k, e := range gs.m {
			if k == keep || !e.done {
				continue
			}
			if oldestKey == "" || e.access < oldest {
				oldestKey, oldest = k, e.access
			}
		}
		if oldestKey == "" { // 其余都在途：暂不淘汰
			return
		}
		delete(gs.m, oldestKey)
	}
}
