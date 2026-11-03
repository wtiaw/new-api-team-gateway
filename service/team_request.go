package service

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
)

const defaultTeamOutputTokens = uint(4096)

// ApplyTeamRequestDefaults supplies an output cap when omitted, including
// passthrough channels. Client-supplied limits and opaque context are retained.
func ApplyTeamRequestDefaults(c *gin.Context, request dto.Request) error {
	policy := TeamPolicyFromContext(c)
	if policy == nil || policy.TeamID == 0 {
		return nil
	}
	var field string
	switch request := request.(type) {
	case *dto.GeneralOpenAIRequest:
		if request.MaxTokens == nil && request.MaxCompletionTokens == nil {
			field = "max_tokens"
		}
	case *dto.OpenAIResponsesRequest:
		if request.MaxOutputTokens == nil {
			field = "max_output_tokens"
		}
	}
	if field == "" {
		return nil
	}
	var body map[string]json.RawMessage
	if err := common.UnmarshalBodyReusable(c, &body); err != nil {
		return err
	}
	if body == nil {
		return errors.New("A JSON request object is required for team funding")
	}
	value, err := common.Marshal(defaultTeamOutputTokens)
	if err != nil {
		return err
	}
	body[field] = value
	raw, err := common.Marshal(body)
	if err != nil {
		return err
	}
	storage, err := common.CreateBodyStorage(raw)
	if err != nil {
		return err
	}
	common.CleanupBodyStorage(c)
	c.Set(common.KeyRequestBody, nil)
	c.Set(common.KeyBodyStorage, storage)
	c.Request.Body = io.NopCloser(storage)
	c.Request.ContentLength = int64(len(raw))
	switch request := request.(type) {
	case *dto.GeneralOpenAIRequest:
		request.MaxTokens = new(defaultTeamOutputTokens)
	case *dto.OpenAIResponsesRequest:
		request.MaxOutputTokens = new(defaultTeamOutputTokens)
	}
	return nil
}
