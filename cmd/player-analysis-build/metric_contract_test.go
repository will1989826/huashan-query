package main

import (
	"testing"

	"huashanquery/internal/analysis"
)

// The offline builder and live profile intentionally use different aggregate types, but they
// must expose exactly the same metric set. Keep additions from silently reaching only one path.
func TestMetricDefinitionsMatchLiveAggregate(t *testing.T) {
	live := (&analysis.Agg{}).Metrics()
	builder := metricDefinitions()
	if len(builder) != len(live) {
		t.Fatalf("builder has %d metrics; live aggregate has %d", len(builder), len(live))
	}
	for _, def := range builder {
		if _, ok := live[def.Key]; !ok {
			t.Errorf("builder metric %q is missing from live aggregate", def.Key)
		}
	}
}
