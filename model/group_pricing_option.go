package model

import (
	"errors"
	"maps"
	"sync"

	"github.com/QuantumNous/new-api/common"
)

// Console compatibility keys and typed settings name the same pricing maps.
// Persist and publish them together so background reload cannot revive old groups.
var groupPricingAliases = [][2]string{
	{"GroupRatio", "group_ratio_setting.group_ratio"},
	{"GroupGroupRatio", "group_ratio_setting.group_group_ratio"},
}

var groupPricingMutationMu sync.Mutex

var errInvalidGroupPricing = errors.New("Group pricing must contain non-negative numbers")
var errConflictingGroupPricing = errors.New("Conflicting group pricing settings")

func groupPricingOptionPair(key string) ([2]string, bool) {
	for _, pair := range groupPricingAliases {
		if key == pair[0] || key == pair[1] {
			return pair, true
		}
	}
	return [2]string{}, false
}

func normalizeGroupPricingValue(key, raw string) (string, error) {
	if key == "GroupRatio" {
		var values map[string]float64
		if common.UnmarshalJsonStr(raw, &values) != nil || values == nil {
			return "", errInvalidGroupPricing
		}
		for _, value := range values {
			if value < 0 {
				return "", errInvalidGroupPricing
			}
		}
		encoded, err := common.Marshal(values)
		return string(encoded), err
	}
	var values map[string]map[string]float64
	if common.UnmarshalJsonStr(raw, &values) != nil || values == nil {
		return "", errInvalidGroupPricing
	}
	for _, ratios := range values {
		if ratios == nil {
			return "", errInvalidGroupPricing
		}
		for _, value := range ratios {
			if value < 0 {
				return "", errInvalidGroupPricing
			}
		}
	}
	encoded, err := common.Marshal(values)
	return string(encoded), err
}

func normalizeGroupPricingUpdates(values map[string]string) (map[string]string, error) {
	result := maps.Clone(values)
	for _, pair := range groupPricingAliases {
		chosen, found := "", false
		for _, key := range pair {
			raw, exists := values[key]
			if !exists {
				continue
			}
			value, err := normalizeGroupPricingValue(pair[0], raw)
			if err != nil {
				return nil, err
			}
			if found && value != chosen {
				return nil, errConflictingGroupPricing
			}
			chosen, found = value, true
		}
		if found {
			result[pair[0]], result[pair[1]] = chosen, chosen
		}
	}
	return result, nil
}

// Old installations may have conflicting rows without an update timestamp.
// Prefer the console field deterministically, including an explicit empty map;
// typed-only installations remain readable by both API names.
func resolveStoredGroupPricingOptions(options []*Option) []*Option {
	values := make(map[string]string)
	result := make([]*Option, 0, len(options))
	for _, option := range options {
		if _, alias := groupPricingOptionPair(option.Key); alias {
			values[option.Key] = option.Value
		} else {
			result = append(result, option)
		}
	}
	for _, pair := range groupPricingAliases {
		value, exists := values[pair[0]]
		if !exists {
			value, exists = values[pair[1]]
		}
		if exists {
			result = append(result, &Option{Key: pair[0], Value: value})
		}
	}
	return result
}
