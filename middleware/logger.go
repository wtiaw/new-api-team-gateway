package middleware

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

const RouteTagKey = "route_tag"

func RouteTag(tag string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(RouteTagKey, tag)
		c.Next()
	}
}

func SetUpLogger(server *gin.Engine) {
	server.Use(redactTaskArtifactAccessQuery())
	server.Use(gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
		var requestID string
		if param.Keys != nil {
			requestID, _ = param.Keys[common.RequestIdKey].(string)
		}
		tag, _ := param.Keys[RouteTagKey].(string)
		if tag == "" {
			tag = "web"
		}
		path := param.Path
		invitationPath := false
		for _, prefix := range []string{"/api/team-invitations/", "/team-invitation/"} {
			if strings.HasPrefix(param.Request.URL.Path, prefix) {
				_, suffix, hasSuffix := strings.Cut(strings.TrimPrefix(param.Request.URL.Path, prefix), "/")
				path = prefix + "[redacted]"
				if hasSuffix && suffix == "accept" {
					path += "/accept"
				}
				invitationPath = true
				break
			}
		}
		// OAuth callbacks carry one-time codes and state in the query string.
		// Redact the log value only; the handler still needs the original query.
		if invitationPath {
			// Bearer invitation secrets must not enter access logs.
		} else if (param.Request.URL.Path == "/sign-in" || param.Request.URL.Path == "/sign-up") && strings.Contains(param.Request.URL.Query().Get("redirect"), "/team-invitation/") {
			path = param.Request.URL.EscapedPath()
		} else if strings.HasPrefix(path, "/api/oauth/") || strings.HasPrefix(path, "/oauth/") {
			path, _, _ = strings.Cut(path, "?")
		} else if param.Request.URL.RawQuery != "" {
			query := param.Request.URL.Query().Encode()
			path = param.Request.URL.EscapedPath() + relaycommon.SanitizeURLForLog("?"+query)
		}
		return fmt.Sprintf("[GIN] %s | %s | %s | %3d | %13v | %15s | %7s %s\n",
			param.TimeStamp.Format("2006/01/02 - 15:04:05"),
			tag,
			requestID,
			param.StatusCode,
			param.Latency,
			param.ClientIP,
			param.Method,
			path,
		)
	}))
}
