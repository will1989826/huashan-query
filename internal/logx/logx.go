// Package logx 是跨层的调试日志（只依赖标准库，可被任意层引用，无循环依赖）。
// 日志写入 exe 同目录的「huashan-query.log」（不可写时退回 %LOCALAPPDATA%），
// 记录关键步骤与错误；Tracef/Recover 会带上调用栈，方便把日志发给作者排查。
package logx

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime/debug"
	"sync"
)

var (
	mu     sync.Mutex
	logger *log.Logger
	path   string
)

func exeDir() string {
	if p, err := os.Executable(); err == nil {
		return filepath.Dir(p)
	}
	return "."
}

// Init 打开日志文件并写入启动信息，返回日志文件路径。
func Init(version string) string {
	candidates := []string{
		filepath.Join(exeDir(), "huashan-query.log"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "huashan-query", "huashan-query.log"),
		filepath.Join(os.TempDir(), "huashan-query.log"),
	}
	var f *os.File
	for _, p := range candidates {
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if fi, err := os.Stat(p); err == nil && fi.Size() > 2<<20 { // >2MB 从头写，避免无限增长
			f, _ = os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		} else {
			f, _ = os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		}
		if f != nil {
			path = p
			break
		}
	}
	var w io.Writer = io.Discard
	if f != nil {
		w = f
	}
	mu.Lock()
	logger = log.New(w, "", log.LstdFlags|log.Lmicroseconds)
	mu.Unlock()
	return path
}

// Path 返回当前日志文件路径。
func Path() string { return path }

func output(level, format string, a ...any) {
	mu.Lock()
	l := logger
	mu.Unlock()
	if l != nil {
		l.Printf("[%s] %s", level, fmt.Sprintf(format, a...))
	}
}

// Infof 记录一条信息。
func Infof(format string, a ...any) { output("INFO", format, a...) }

// Errorf 记录一条错误。
func Errorf(format string, a ...any) { output("ERROR", format, a...) }

// Tracef 记录一条错误并附带当前调用栈。
func Tracef(format string, a ...any) {
	output("ERROR", format+"\n%s", append(a, debug.Stack())...)
}

// Recover 供 defer 使用：捕获 panic，记录现场与调用栈（不再向上抛）。
func Recover(where string) {
	if r := recover(); r != nil {
		output("PANIC", "%s: %v\n%s", where, r, debug.Stack())
	}
}
