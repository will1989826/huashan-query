package server

import (
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestStartOrReuseUsesCompatibleInstance(t *testing.T) {
	address := freeAddress(t)
	oldSvc, oldEvt := svcTo("http://unused", fakeTP{})
	oldURL, oldDone, oldClose, err := Run(oldSvc, oldEvt, Options{Address: address, Version: "v1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	defer oldClose()

	newSvc, newEvt := svcTo("http://unused", fakeTP{})
	instance, err := StartOrReuse(newSvc, newEvt, Options{Address: address, Version: "v1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	if !instance.Reused || instance.URL != oldURL || instance.Done != nil {
		t.Fatalf("instance = %+v, want reused %s", instance, oldURL)
	}
	select {
	case <-oldDone:
		t.Fatal("compatible instance was stopped instead of reused")
	default:
	}
}

func TestReuseRenewsHeartbeatWindow(t *testing.T) {
	defer swapDurations(300*time.Millisecond, 5*time.Second, 5*time.Millisecond)()
	address := freeAddress(t)
	oldSvc, oldEvt := svcTo("http://unused", fakeTP{})
	oldURL, oldDone, oldClose, err := Run(oldSvc, oldEvt, Options{Address: address, Version: "v1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	defer oldClose()
	if st, _ := post(t, oldURL+"api/heartbeat"); st != http.StatusNoContent {
		t.Fatalf("initial heartbeat = %d, want 204", st)
	}

	time.Sleep(220 * time.Millisecond)
	newSvc, newEvt := svcTo("http://unused", fakeTP{})
	instance, err := StartOrReuse(newSvc, newEvt, Options{Address: address, Version: "v1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	if !instance.Reused {
		t.Fatal("compatible instance was not reused")
	}

	// This crosses the original deadline but remains inside the renewed heartbeat window.
	time.Sleep(160 * time.Millisecond)
	select {
	case <-oldDone:
		t.Fatal("reused instance expired on its original heartbeat deadline")
	default:
	}
	select {
	case <-oldDone:
	case <-time.After(300 * time.Millisecond):
		t.Fatal("reused instance did not expire after the renewed heartbeat window")
	}
}

func TestConcurrentLaunchesShareOneInstance(t *testing.T) {
	address := freeAddress(t)
	start := make(chan struct{})
	instances := make(chan Instance, 2)
	errs := make(chan error, 2)
	var launchers sync.WaitGroup
	for range 2 {
		launchers.Add(1)
		go func() {
			defer launchers.Done()
			svc, evt := svcTo("http://unused", fakeTP{})
			<-start
			instance, err := StartOrReuse(svc, evt, Options{Address: address, Version: "v1.2.3"})
			if err != nil {
				errs <- err
				return
			}
			instances <- instance
		}()
	}
	close(start)
	launchers.Wait()
	close(instances)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	var owned, reused int
	var owner Instance
	defer func() {
		if owner.Close != nil {
			_ = owner.Close()
		}
	}()
	for instance := range instances {
		if instance.URL != "http://"+address+"/" {
			t.Fatalf("URL = %q, want stable address", instance.URL)
		}
		if instance.Reused {
			reused++
		} else {
			owned++
			owner = instance
		}
	}
	if owned != 1 || reused != 1 {
		t.Fatalf("owned=%d reused=%d, want one of each", owned, reused)
	}
}

func TestStartOrReuseReplacesIncompatibleInstance(t *testing.T) {
	address := freeAddress(t)
	oldSvc, oldEvt := svcTo("http://unused", fakeTP{})
	_, oldDone, oldClose, err := Run(oldSvc, oldEvt, Options{Address: address, Version: "v1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	oldClosed := make(chan struct{})
	go func() {
		<-oldDone
		_ = oldClose()
		close(oldClosed)
	}()

	newSvc, newEvt := svcTo("http://unused", fakeTP{})
	instance, err := StartOrReuse(newSvc, newEvt, Options{Address: address, Version: "v2.0.0"})
	if err != nil {
		_ = oldClose()
		t.Fatal(err)
	}
	defer instance.Close()
	if instance.Reused {
		t.Fatal("incompatible instance was reused")
	}
	if instance.URL != "http://"+address+"/" {
		t.Fatalf("URL = %q, want stable address", instance.URL)
	}
	select {
	case <-oldClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("old instance did not stop during takeover")
	}

	info, err := probeInstance(instance.URL)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != "v2.0.0" || info.State != instanceStateReady {
		t.Fatalf("new health = %+v", info)
	}
}

func TestStartOrReuseRejectsForeignServiceOnStablePort(t *testing.T) {
	defer swapInstanceTimings(50*time.Millisecond, 120*time.Millisecond, []time.Duration{10 * time.Millisecond})()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	foreign := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"app":"another-app","protocol":1,"version":"v1","state":"ready"}`))
	})}
	go foreign.Serve(listener)
	defer foreign.Close()

	svc, evt := svcTo("http://unused", fakeTP{})
	if _, err := StartOrReuse(svc, evt, Options{Address: listener.Addr().String(), Version: "v1.0.0"}); err == nil {
		t.Fatal("foreign service should keep the stable address unavailable")
	}
}

func TestDevelopmentBuildIsNotReused(t *testing.T) {
	if reusableInstance(InstanceInfo{
		App: instanceApp, Protocol: instanceProtocol, Version: "dev", State: instanceStateReady,
	}, "dev") {
		t.Fatal("development instances must be replaced so code changes take effect")
	}
}

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func swapInstanceTimings(probe, retry time.Duration, delays []time.Duration) func() {
	oldProbe, oldRetry, oldDelays := instanceProbeTimeout, instanceRetryWindow, instanceRetryDelays
	instanceProbeTimeout, instanceRetryWindow, instanceRetryDelays = probe, retry, delays
	return func() {
		instanceProbeTimeout, instanceRetryWindow, instanceRetryDelays = oldProbe, oldRetry, oldDelays
	}
}
