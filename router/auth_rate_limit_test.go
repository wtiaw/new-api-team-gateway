package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthenticationRateLimitsAreIndependent(t *testing.T) {
	previousRedis, previousClient := common.RedisEnabled, common.RDB
	previousCritical, previousNum, previousDuration := common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration
	previousAPI, previousSecure := common.GlobalApiRateLimitEnable, common.SessionCookieSecure
	t.Cleanup(func() {
		common.RedisEnabled, common.RDB = previousRedis, previousClient
		common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = previousCritical, previousNum, previousDuration
		common.GlobalApiRateLimitEnable, common.SessionCookieSecure = previousAPI, previousSecure
	})
	gin.SetMode(gin.TestMode)
	common.CriticalRateLimitEnable, common.CriticalRateLimitNum, common.CriticalRateLimitDuration = true, 2, 1200
	common.GlobalApiRateLimitEnable, common.SessionCookieSecure = false, true
	for index, backend := range []string{"redis", "memory"} {
		t.Run(backend, func(t *testing.T) {
			var server *miniredis.Miniredis
			common.RedisEnabled = backend == "redis"
			if common.RedisEnabled {
				server = miniredis.RunT(t)
				client := redis.NewClient(&redis.Options{Addr: server.Addr()})
				t.Cleanup(func() { require.NoError(t, client.Close()) })
				common.RDB = client
			}
			engine := gin.New()
			require.NoError(t, engine.SetTrustedProxies(nil))
			SetApiRouter(engine)
			engine.POST("/management-probe", middleware.CriticalRateLimit(), func(c *gin.Context) { c.Status(http.StatusNoContent) })
			address := "192.0.2.88:1234"
			if index == 1 {
				address = "192.0.2.89:1234"
			}
			request := func(path, origin string) *httptest.ResponseRecorder {
				recorder := httptest.NewRecorder()
				req := httptest.NewRequest(http.MethodPost, "https://example.com"+path, strings.NewReader("{"))
				req.RemoteAddr = address
				req.Header.Set("Origin", origin)
				req.Header.Set("Content-Type", "application/json")
				engine.ServeHTTP(recorder, req)
				return recorder
			}
			for range 2 {
				require.Equal(t, http.StatusNoContent, request("/management-probe", "https://example.com").Code)
			}
			require.Equal(t, http.StatusTooManyRequests, request("/management-probe", "https://example.com").Code)
			for range 21 {
				// Missing cookies are still rejected; no database or credentials needed.
				require.Equal(t, http.StatusUnauthorized, request("/api/user/auth/refresh", "https://example.com").Code)
			}
			for range 2 {
				require.Equal(t, http.StatusOK, request("/api/user/login", "https://example.com").Code)
			}
			for _, route := range []string{"/login", "/login/2fa", "/login/verify", "/login/passkey/begin", "/login/passkey/finish", "/passkey/login/begin", "/passkey/login/finish"} {
				response := request("/api/user"+route, "https://example.com")
				assert.Equal(t, http.StatusTooManyRequests, response.Code, route)
				assert.NotEmpty(t, response.Header().Get("Retry-After"), route)
			}
			require.Equal(t, http.StatusOK, request("/api/user/auth/logout", "https://example.com").Code)
			require.Equal(t, http.StatusForbidden, request("/api/user/auth/refresh", "https://untrusted.invalid").Code)
			for range 38 {
				require.Equal(t, http.StatusUnauthorized, request("/api/user/auth/refresh", "https://example.com").Code)
			}
			limited := request("/api/user/auth/refresh", "https://example.com")
			assert.Equal(t, http.StatusTooManyRequests, limited.Code)
			assert.Equal(t, "60", limited.Header().Get("Retry-After"))
			if server != nil {
				server.FastForward(61 * time.Second)
				assert.Equal(t, http.StatusUnauthorized, request("/api/user/auth/refresh", "https://example.com").Code)
				assert.Equal(t, http.StatusTooManyRequests, request("/api/user/login", "https://example.com").Code)
			}
			address = "198.51.100.88:1234"
			if index == 1 {
				address = "198.51.100.89:1234"
			}
			assert.Equal(t, http.StatusOK, request("/api/user/login", "https://example.com").Code)
		})
	}
}
