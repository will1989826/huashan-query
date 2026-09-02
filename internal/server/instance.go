package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"syscall"
	"time"

	"huashanquery/internal/event"
	"huashanquery/internal/logx"
	"huashanquery/internal/player"
)

const (
	// StableAddress keeps the browser origin unchanged so localStorage survives process restarts.
	StableAddress = "127.0.0.1:47821"

	instanceApp           = "huashan-query"
	instanceProtocol      = 1
	instanceStateReady    = "ready"
	instanceStateStopping = "stopping"
)

var (
	instanceProbeTimeout = time.Second
	instanceRetryWindow  = 5 * time.Second
	instanceRetryDelays  = []time.Duration{25 * time.Millisecond, 50 * time.Millisecond, 100 * time.Millisecond, 200 * time.Millisecond}
)

// ErrStableAddressUnavailable means another process kept the fixed browser origin occupied.
var ErrStableAddressUnavailable = errors.New("stable local address unavailable")

// InstanceInfo is returned by /api/health so a new launcher can identify the process on the stable port.
type InstanceInfo struct {
	App      string `json:"app"`
	Protocol int    `json:"protocol"`
	Version  string `json:"version"`
	State    string `json:"state"`
}

// Instance describes either the server owned by this process or a compatible server that was already running.
type Instance struct {
	URL    string
	Done   <-chan struct{}
	Close  func() error
	Reused bool
}

// StartOrReuse opens one stable local origin. A compatible release is reused; an incompatible instance is asked to
// stop, then the fixed address is acquired with bounded retries. Development builds always replace older dev builds.
func StartOrReuse(svc *player.Service, evt *event.Service, opt Options) (Instance, error) {
	if opt.Address == "" {
		opt.Address = StableAddress
	}
	baseURL := "http://" + opt.Address + "/"
	deadline := time.Now().Add(instanceRetryWindow)
	occupant := ""
	var lastProbeErr error

	if info, err := probeInstance(baseURL); err == nil {
		if reusableInstance(info, opt.Version) {
			wakeErr := wakeInstance(baseURL)
			if wakeErr == nil {
				logx.Infof("reusing local server at %s for version %s", opt.Address, opt.Version)
				return reusedInstance(baseURL), nil
			}
			lastProbeErr = fmt.Errorf("wake compatible instance: %w", wakeErr)
		}
		if info.App == instanceApp && info.State != instanceStateStopping {
			logx.Infof("replacing local server at %s (running version %s, requested version %s)", opt.Address, info.Version, opt.Version)
			requestInstanceStop(baseURL)
		} else if info.App != instanceApp {
			occupant = instanceDescription(info)
			logx.Errorf("stable local address %s is used by another service: %s", opt.Address, occupant)
		}
	} else {
		lastProbeErr = err
	}

	var lastErr error
	for attempt := 0; ; attempt++ {
		url, done, closeFn, err := Run(svc, evt, opt)
		if err == nil {
			logx.Infof("local server started at %s for version %s", opt.Address, opt.Version)
			return Instance{URL: url, Done: done, Close: closeFn}, nil
		}
		lastErr = err
		if !addressInUse(err) {
			return Instance{}, err
		}

		if info, probeErr := probeInstance(baseURL); probeErr == nil {
			lastProbeErr = nil
			if reusableInstance(info, opt.Version) {
				wakeErr := wakeInstance(baseURL)
				if wakeErr == nil {
					logx.Infof("reusing concurrently started local server at %s for version %s", opt.Address, opt.Version)
					return reusedInstance(baseURL), nil
				}
				lastProbeErr = fmt.Errorf("wake compatible instance: %w", wakeErr)
			}
			if info.App == instanceApp && info.State != instanceStateStopping {
				requestInstanceStop(baseURL)
			} else if info.App != instanceApp && occupant == "" {
				occupant = instanceDescription(info)
				logx.Errorf("stable local address %s is used by another service: %s", opt.Address, occupant)
			}
		} else {
			lastProbeErr = probeErr
		}

		if !time.Now().Before(deadline) {
			break
		}
		delay := instanceRetryDelays[min(attempt, len(instanceRetryDelays)-1)]
		if remaining := time.Until(deadline); delay > remaining {
			delay = remaining
		}
		time.Sleep(delay)
	}

	detail := occupant
	if detail == "" && lastProbeErr != nil {
		detail = fmt.Sprintf("last health probe failed: %v", lastProbeErr)
	}
	if detail == "" {
		detail = "health probe did not identify the listener"
	}
	return Instance{}, fmt.Errorf("%w: %s remained occupied for %s (%s): %v", ErrStableAddressUnavailable, opt.Address, instanceRetryWindow, detail, lastErr)
}

func reusedInstance(url string) Instance {
	return Instance{URL: url, Reused: true, Close: func() error { return nil }}
}

func reusableInstance(info InstanceInfo, version string) bool {
	return info.App == instanceApp &&
		info.Protocol == instanceProtocol &&
		info.State == instanceStateReady &&
		version != "" && version != "dev" && info.Version == version
}

func instanceDescription(info InstanceInfo) string {
	return fmt.Sprintf("app=%q protocol=%d version=%q state=%q", info.App, info.Protocol, info.Version, info.State)
}

func probeInstance(baseURL string) (InstanceInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), instanceProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/health", nil)
	if err != nil {
		return InstanceInfo{}, err
	}
	req.Close = true
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return InstanceInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return InstanceInfo{}, fmt.Errorf("health endpoint returned %d", resp.StatusCode)
	}
	var info InstanceInfo
	dec := json.NewDecoder(io.LimitReader(resp.Body, 4096))
	if err := dec.Decode(&info); err != nil {
		return InstanceInfo{}, err
	}
	if info.App == "" || info.State == "" {
		return InstanceInfo{}, errors.New("health endpoint returned incomplete identity")
	}
	return info, nil
}

func wakeInstance(baseURL string) error {
	ctx, cancel := context.WithTimeout(context.Background(), instanceProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/heartbeat", nil)
	if err != nil {
		return err
	}
	req.Close = true
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("heartbeat endpoint returned %d", resp.StatusCode)
	}
	return nil
}

func requestInstanceStop(baseURL string) {
	ctx, cancel := context.WithTimeout(context.Background(), instanceProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/api/quit", nil)
	if err != nil {
		logx.Errorf("create local instance stop request failed: %v", err)
		return
	}
	req.Close = true
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// The old listener can close before the response reaches the launcher; retrying the bind is authoritative.
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		logx.Errorf("local instance stop request returned status %d", resp.StatusCode)
	}
}

func addressInUse(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	var errno syscall.Errno
	return errors.As(err, &errno) && errno == 10048 // WSAEADDRINUSE on Windows.
}
