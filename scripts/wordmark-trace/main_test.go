package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandProcess(t *testing.T) {
	if os.Getenv("WORDMARK_TRACE_TEST_PROCESS") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{"wordmark-trace"}, os.Args[i+1:]...)
			main()
			return
		}
	}
	t.Fatal("missing command separator")
}

func TestCommandOutputRequirements(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.SetRGBA(x, y, color.RGBA{255, 255, 255, 255})
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, img, nil); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "source.jpg")
	if err := os.WriteFile(source, encoded.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"probe", "crop", "mask", "trace"} {
		t.Run(command, func(t *testing.T) {
			cmd := exec.Command(executable, "-test.run=^TestCommandProcess$", "--", command, "-in", source, "-rect", "0,0,8,8")
			cmd.Env = append(os.Environ(), "WORDMARK_TRACE_TEST_PROCESS=1")
			output, err := cmd.CombinedOutput()
			if command == "probe" {
				if err != nil || !strings.Contains(string(output), "body    #ffffff  (64 px)") {
					t.Fatalf("probe without -out: err=%v output=%s", err, output)
				}
			} else if err == nil || !strings.Contains(string(output), "-out is required for "+command) {
				t.Fatalf("missing output path: err=%v output=%s", err, output)
			}
		})
	}
}
