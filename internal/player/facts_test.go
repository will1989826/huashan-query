package player

import "testing"

func TestApplyFirstVoteZhanbian(t *testing.T) {
	newFacts := func() map[int]*SeatFacts {
		facts := map[int]*SeatFacts{}
		for seat := 1; seat <= 12; seat++ {
			facts[seat] = &SeatFacts{Seat: seat}
		}
		return facts
	}
	camps := map[int]string{1: "good", 2: "good", 3: "good", 4: "good", 5: "good", 9: "wolf"}
	facts := newFacts()
	applyFirstVoteZhanbian(facts, camps, 1, nil, nil, 2, []Vote{
		{Seat: 1, Target: 4},                // The real seer does not enter the metric.
		{Seat: 2, Target: 4},                // Matching the seer is correct.
		{Seat: 3, Target: 9},                // A different wolf vote is not correct here.
		{Seat: 4, Target: 9},                // The seer's good target voting wolf is correct.
		{Seat: 5, Target: 0, Abstain: true}, // An abstention is an opportunity but not correct.
	})
	for _, seat := range []int{2, 3, 4, 5} {
		if facts[seat].ZhanbianAtt != 1 {
			t.Errorf("seat %d = %+v, want one opportunity", seat, facts[seat])
		}
	}
	for _, seat := range []int{2, 4} {
		if facts[seat].ZhanbianCorrect != 1 {
			t.Errorf("seat %d = %+v, want correct", seat, facts[seat])
		}
	}
	for _, seat := range []int{3, 5} {
		if facts[seat].ZhanbianCorrect != 0 {
			t.Errorf("seat %d = %+v, want not correct", seat, facts[seat])
		}
	}
	if facts[1].ZhanbianAtt != 0 || facts[1].ZhanbianCorrect != 0 {
		t.Errorf("real seer must be excluded, got %+v", facts[1])
	}

	facts = newFacts()
	applyFirstVoteZhanbian(facts, camps, 1, map[int]Death{1: {Seat: 1, Day: 1, Phase: "night", Cause: causeKnife}}, nil, 3, []Vote{
		{Seat: 2, Target: 9}, {Seat: 3, Target: 4},
	})
	if facts[2].ZhanbianAtt != 1 || facts[2].ZhanbianCorrect != 1 || facts[3].ZhanbianCorrect != 0 {
		t.Errorf("first-night seer case = seat2 %+v seat3 %+v", facts[2], facts[3])
	}

	facts = newFacts()
	applyFirstVoteZhanbian(facts, camps, 1, map[int]Death{1: {Seat: 1, Day: 2, Phase: "night", Cause: causeKnife}, 2: {Seat: 2, Day: 2, Phase: "night", Cause: causeKnife}}, nil, 3, []Vote{{Seat: 2, Target: 9}, {Seat: 3, Target: 9}})
	if facts[2].ZhanbianAtt != 0 || facts[3].ZhanbianAtt != 0 {
		t.Errorf("later-night seer death must suppress the metric: seat2 %+v seat3 %+v", facts[2], facts[3])
	}

	for _, votes := range [][]Vote{
		{{Seat: 1, Target: 0, Abstain: true}, {Seat: 2, Target: 9}},
		{{Seat: 2, Target: 9}},
	} {
		facts = newFacts()
		applyFirstVoteZhanbian(facts, camps, 1, nil, nil, 2, votes)
		if facts[2].ZhanbianAtt != 0 || facts[2].ZhanbianCorrect != 0 {
			t.Errorf("missing seer target must suppress the metric, got %+v", facts[2])
		}
	}
}
