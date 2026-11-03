package router

import (
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

func setTeamRoutes(api *gin.RouterGroup) {
	teams := api.Group("/teams", middleware.UserAuth(), middleware.SessionCookieOriginGuard(), middleware.DisableCache())
	teams.GET("", controller.ListTeams)
	teams.POST("", middleware.CriticalRateLimit(), controller.CreateTeam)
	teams.GET("/:id", controller.GetTeam)
	teams.GET("/:id/overview", controller.GetTeamOverview)
	teams.PUT("/:id", middleware.CriticalRateLimit(), controller.UpdateTeam)
	teams.GET("/:id/quota", controller.ListTeamBalanceOperations)
	teams.POST("/:id/quota", middleware.CriticalRateLimit(), controller.AdjustTeamBalance)
	teams.GET("/:id/members", controller.ListTeamMembers)
	teams.PUT("/:id/members/:user_id", middleware.CriticalRateLimit(), controller.UpdateTeamMember)
	teams.DELETE("/:id/members/:user_id", middleware.CriticalRateLimit(), controller.DeleteTeamMember)
	teams.GET("/:id/invitations", controller.ListTeamInvitations)
	teams.POST("/:id/invitations", middleware.CriticalRateLimit(), controller.CreateTeamInvitation)
	teams.DELETE("/:id/invitations/:invite_id", middleware.CriticalRateLimit(), controller.RevokeTeamInvitation)
	teams.GET("/:id/usage", controller.ListTeamUsage)
	teams.GET("/:id/usage/export", controller.ExportTeamUsage)
	invites := api.Group("/team-invitations", middleware.UserAuth(), middleware.SessionCookieOriginGuard(), middleware.DisableCache(), middleware.CriticalRateLimit())
	invites.GET("/:token", controller.PreviewTeamInvitation)
	invites.POST("/:token/accept", controller.AcceptTeamInvitation)
	policies := api.Group("/team-key-policies", middleware.UserAuth(), middleware.SessionCookieOriginGuard(), middleware.DisableCache())
	policies.GET("/:token_id", controller.GetTeamKeyPolicy)
	policies.PUT("/:token_id", middleware.CriticalRateLimit(), controller.SetTeamKeyPolicy)
}
