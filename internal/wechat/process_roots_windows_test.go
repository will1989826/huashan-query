//go:build windows

package wechat

import (
	"reflect"
	"testing"
)

func TestParseRunningRootLines(t *testing.T) {
	got := parseRunningRootLines("\ufeffC:\\Users\\tester\\AppData\\Roaming\\Tencent\\xwechat\\radium\r\nE:\\微信\\xwechat_files\r\nC:\\Users\\tester\\AppData\\Roaming\\Tencent\\xwechat\\radium\r\nrelative\r\n")
	want := []string{
		`C:\Users\tester\AppData\Roaming\Tencent\xwechat\radium`,
		`E:\微信\xwechat_files`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseRunningRootLines() = %v, want %v", got, want)
	}
}
