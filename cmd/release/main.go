// 一键发版工具（开发者本机用，不打进 exe）。用法：release.bat（或 go run ./cmd/release）。
// 步骤：读 VERSION → 构建 exe → 打 tag 并推 GitHub+Gitee → Gitee 建发行版+传 exe → 写 latest.json → 提交并推送。
// 所有部署信息都从未入库的本地文件读取，不写死在代码里：
//   - deploy-token.txt：Gitee 私人令牌（发版必需）
//   - deploy-url.txt  ：更新清单 raw 地址（构建注入 + 据此解析 owner/repo）
// 发行版说明与 latest.json 的 notes 取自 CHANGELOG.md 里当前版本那一节（单一事实来源）。
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "\n发版失败："+err.Error())
		os.Exit(1)
	}
	fmt.Println("\n发版完成 ✅")
}

func run() error {
	ver, err := readTrim("VERSION")
	if err != nil {
		return fmt.Errorf("读取 VERSION 失败：%w", err)
	}
	token, err := readTrim("deploy-token.txt")
	if err != nil || token == "" {
		return fmt.Errorf("缺少 deploy-token.txt（Gitee 私人令牌）——请在项目根目录放一个只含令牌的 deploy-token.txt")
	}
	rawURL, err := readTrim("deploy-url.txt")
	if err != nil || rawURL == "" {
		return fmt.Errorf("缺少 deploy-url.txt（更新清单 raw 地址）")
	}
	owner, repo, err := parseOwnerRepo(rawURL)
	if err != nil {
		return err
	}
	tag := "v" + ver
	exeName := fmt.Sprintf("huashan-query-v%s.exe", ver)
	exePath := "bin/" + exeName
	dlURL := fmt.Sprintf("https://gitee.com/%s/%s/releases/download/%s/%s", owner, repo, tag, exeName)

	body, notes := changelogSection(ver)
	if strings.TrimSpace(body) == "" {
		return fmt.Errorf("CHANGELOG.md 里找不到 [%s] 那一节，请先补上再发版", ver)
	}

	// 0) 发版前校验：在 main、工作树+index 完全干净、同名 tag（若存在）须指向当前 HEAD——
	//    确保发布的 exe、tag、源码三者一致，也避免把无关暂存内容一并提交推送。
	if b, _ := output("git", "rev-parse", "--abbrev-ref", "HEAD"); strings.TrimSpace(b) != "main" {
		return fmt.Errorf("当前不在 main 分支，请切到 main 再发版")
	}
	if st, _ := output("git", "status", "--porcelain"); strings.TrimSpace(st) != "" {
		return fmt.Errorf("工作树有未提交 / 未跟踪改动，请先提交或清理后再发版：\n%s", strings.TrimSpace(st))
	}
	hb, _ := output("git", "rev-parse", "HEAD")
	head := strings.TrimSpace(hb)
	if sh("git", "rev-parse", "-q", "--verify", "refs/tags/"+tag) == nil {
		tc, _ := output("git", "rev-parse", tag+"^{commit}")
		if strings.TrimSpace(tc) != head {
			return fmt.Errorf("标签 %s 已存在但不指向当前 HEAD（%s ≠ %s），请换版本号或修正标签", tag, short(strings.TrimSpace(tc)), short(head))
		}
	}
	gh, gerr := output("git", "remote", "get-url", "origin")
	githubURL := strings.TrimSpace(gh)
	if gerr != nil || githubURL == "" {
		return fmt.Errorf("取 origin(GitHub) 地址失败：%v", gerr)
	}
	giteePush := fmt.Sprintf("https://%s@gitee.com/%s/%s.git", token, owner, repo)

	// 1) 构建发行 exe（版本号 + 更新地址注入）——工作树已确认干净，exe 与 HEAD/tag 一致
	fmt.Println("→ 构建", exePath)
	if err := sh("go", "build",
		"-ldflags", fmt.Sprintf("-s -w -H windowsgui -X main.version=%s -X main.updateURL=%s", tag, rawURL),
		"-o", exePath, "."); err != nil {
		return fmt.Errorf("go build 失败：%w", err)
	}

	// 2) 打 tag 并推送 main + tag 到两个远端（tag 需先到 Gitee，发行版才能引用）
	if sh("git", "rev-parse", "-q", "--verify", "refs/tags/"+tag) != nil {
		fmt.Println("→ 打标签", tag)
		if err := sh("git", "tag", "-a", tag, "-m", tag); err != nil {
			return fmt.Errorf("打标签失败：%w", err)
		}
	}
	fmt.Println("→ 推送 main + tag 到 GitHub / Gitee")
	if err := sh("git", "push", githubURL, "main", "--follow-tags"); err != nil {
		return fmt.Errorf("推送 GitHub 失败：%w", err)
	}
	if err := sh("git", "push", giteePush, "main", "--follow-tags"); err != nil {
		return fmt.Errorf("推送 Gitee 失败：%w", err)
	}

	// 3) 建发行版（已存在则复用）并上传 exe——此后新版直链可用
	fmt.Println("→ 创建 / 获取 Gitee 发行版", tag)
	relID, err := ensureRelease(owner, repo, token, tag, "Huashan Query "+tag, body)
	if err != nil {
		return err
	}
	fmt.Println("→ 上传附件", exeName)
	if err := uploadAsset(owner, repo, token, relID, exePath, exeName); err != nil {
		return err
	}

	// 4) 把 latest.json 安全上线：写文件 → 有变更才提交(失败即中止) → 先推清单托管端(Gitee)成功、再推 GitHub。
	fmt.Println("→ 更新 latest.json")
	if err := writeManifest(ver, dlURL, notes); err != nil {
		return err
	}
	if err := sh("git", "add", "latest.json"); err != nil {
		return err
	}
	if staged, _ := output("git", "diff", "--cached", "--name-only"); strings.TrimSpace(staged) != "" {
		if err := sh("git", "commit", "-m", "latest.json → "+ver); err != nil {
			return fmt.Errorf("提交 latest.json 失败：%w", err)
		}
	} else {
		fmt.Println("  latest.json 无变化，跳过提交")
	}
	if err := sh("git", "push", giteePush, "main"); err != nil {
		return fmt.Errorf("推送 latest.json 到 Gitee(清单托管端) 失败：%w", err)
	}
	if err := sh("git", "push", githubURL, "main"); err != nil {
		return fmt.Errorf("推送 latest.json 到 GitHub 失败：%w", err)
	}

	// 保留历史发行版（不清理）——分享出去的当前版直链因此长期有效。
	fmt.Println("\n下载直链：", dlURL)
	return nil
}

// —— Gitee API ——

func api() *http.Client { return &http.Client{Timeout: 3 * time.Minute} }

// ensureRelease 建发行版；若该 tag 已有发行版则复用其 id。
func ensureRelease(owner, repo, token, tag, name, body string) (int64, error) {
	form := map[string]string{"access_token": token, "tag_name": tag, "name": name, "body": body, "target_commitish": "main", "prerelease": "false"}
	b, status, err := postForm(fmt.Sprintf("https://gitee.com/api/v5/repos/%s/%s/releases", owner, repo), form)
	if err != nil {
		return 0, err
	}
	if status >= 200 && status < 300 {
		var r struct {
			ID int64 `json:"id"`
		}
		json.Unmarshal(b, &r)
		return r.ID, nil
	}
	// 已存在：按 tag 查回 id
	gb, gs, gerr := get(fmt.Sprintf("https://gitee.com/api/v5/repos/%s/%s/releases/tags/%s?access_token=%s", owner, repo, tag, token))
	if gerr == nil && gs >= 200 && gs < 300 {
		var r struct {
			ID int64 `json:"id"`
		}
		if json.Unmarshal(gb, &r) == nil && r.ID != 0 {
			return r.ID, nil
		}
	}
	return 0, fmt.Errorf("创建发行版失败(%d)：%s", status, string(b))
}

func uploadAsset(owner, repo, token string, relID int64, path, filename string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	_ = w.WriteField("access_token", token)
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	if _, err := io.Copy(fw, f); err != nil {
		return err
	}
	w.Close()
	url := fmt.Sprintf("https://gitee.com/api/v5/repos/%s/%s/releases/%d/attach_files", owner, repo, relID)
	req, _ := http.NewRequest("POST", url, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := api().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("上传附件失败(%d)：%s", resp.StatusCode, string(rb))
	}
	return nil
}

func postForm(url string, fields map[string]string) ([]byte, int, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	w.Close()
	req, _ := http.NewRequest("POST", url, &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	resp, err := api().Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
}

func get(url string) ([]byte, int, error) {
	resp, err := api().Get(url)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return b, resp.StatusCode, nil
}

// —— 辅助 ——

func writeManifest(ver, url, notes string) error {
	m := map[string]string{"version": ver, "url": url, "notes": notes}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile("latest.json", append(b, '\n'), 0o644)
}

// changelogSection 取 CHANGELOG.md 里 "## [ver]" 那一节：body=整段项目符号原文；notes=各条去掉 "- " 后按换行拼（给更新提示用）。
func changelogSection(ver string) (body, notes string) {
	data, err := os.ReadFile("CHANGELOG.md")
	if err != nil {
		return "", ""
	}
	lines := strings.Split(string(data), "\n")
	start := -1
	head := "## [" + ver + "]"
	for i, ln := range lines {
		if strings.HasPrefix(ln, head) {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return "", ""
	}
	var bodyLines, noteLines []string
	for _, ln := range lines[start:] {
		if strings.HasPrefix(ln, "## [") {
			break
		}
		t := strings.TrimSpace(ln)
		if t == "" {
			continue
		}
		bodyLines = append(bodyLines, ln)
		if strings.HasPrefix(t, "- ") {
			noteLines = append(noteLines, strings.TrimPrefix(t, "- "))
		}
	}
	return strings.TrimSpace(strings.Join(bodyLines, "\n")), strings.Join(noteLines, "\n")
}

func short(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return s
}

func readTrim(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func sh(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	return cmd.Run()
}

func output(name string, args ...string) (string, error) {
	var out bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = &out, os.Stderr
	err := cmd.Run()
	return out.String(), err
}

func parseOwnerRepo(rawURL string) (owner, repo string, err error) {
	// 形如 https://gitee.com/{owner}/{repo}/raw/main/latest.json
	s := rawURL
	const host = "gitee.com/"
	i := strings.Index(s, host)
	if i < 0 {
		return "", "", fmt.Errorf("deploy-url.txt 不是 gitee.com 地址，无法解析 owner/repo：%s", rawURL)
	}
	parts := strings.Split(s[i+len(host):], "/")
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("无法从 deploy-url.txt 解析 owner/repo：%s", rawURL)
	}
	return parts[0], parts[1], nil
}
