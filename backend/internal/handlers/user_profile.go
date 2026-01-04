package handlers

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/jagadeesh/grainlify/backend/internal/auth"
	"github.com/jagadeesh/grainlify/backend/internal/config"
	"github.com/jagadeesh/grainlify/backend/internal/db"
)

type UserProfileHandler struct {
	cfg config.Config
	db  *db.DB
}

func NewUserProfileHandler(cfg config.Config, d *db.DB) *UserProfileHandler {
	return &UserProfileHandler{cfg: cfg, db: d}
}

// Profile returns the user's profile statistics including:
// - Total contribution count (only for verified projects in our system)
// - Most active languages (based on contributions)
// - Most active ecosystems (based on contributions)
func (h *UserProfileHandler) Profile() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if h.db == nil || h.db.Pool == nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "db_not_configured"})
		}

		// Get user ID from JWT
		sub, _ := c.Locals(auth.LocalUserID).(string)
		userID, err := uuid.Parse(sub)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid_user"})
		}

		// Get user's GitHub login from github_accounts
		var githubLogin *string
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT login
FROM github_accounts
WHERE user_id = $1
`, userID).Scan(&githubLogin)
		if err != nil {
			// User doesn't have GitHub account linked
			return c.Status(fiber.StatusOK).JSON(fiber.Map{
				"contributions_count": 0,
				"languages":           []fiber.Map{},
				"ecosystems":          []fiber.Map{},
			})
		}

		if githubLogin == nil || *githubLogin == "" {
			return c.Status(fiber.StatusOK).JSON(fiber.Map{
				"contributions_count": 0,
				"languages":           []fiber.Map{},
				"ecosystems":          []fiber.Map{},
			})
		}

		// Count total contributions (issues + PRs) for verified projects only
		var contributionsCount int
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT 
  (SELECT COUNT(*) FROM github_issues i
   INNER JOIN projects p ON i.project_id = p.id
   WHERE i.author_login = $1 AND p.status = 'verified')
  +
  (SELECT COUNT(*) FROM github_pull_requests pr
   INNER JOIN projects p ON pr.project_id = p.id
   WHERE pr.author_login = $1 AND p.status = 'verified')
`, *githubLogin).Scan(&contributionsCount)
		if err != nil {
			slog.Error("failed to count contributions", "error", err, "user_id", userID, "github_login", *githubLogin)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "contribution_count_failed"})
		}

		// Get most active languages (top 10)
		// Count contributions per language, only for verified projects
		langRows, err := h.db.Pool.Query(c.Context(), `
SELECT 
  p.language,
  COUNT(*) as contribution_count
FROM (
  SELECT project_id FROM github_issues WHERE author_login = $1
  UNION ALL
  SELECT project_id FROM github_pull_requests WHERE author_login = $1
) contributions
INNER JOIN projects p ON contributions.project_id = p.id
WHERE p.status = 'verified' AND p.language IS NOT NULL
GROUP BY p.language
ORDER BY contribution_count DESC, p.language ASC
LIMIT 10
`, *githubLogin)
		if err != nil {
			slog.Error("failed to fetch languages", "error", err, "user_id", userID, "github_login", *githubLogin)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "languages_fetch_failed"})
		}
		defer langRows.Close()

		var languages []fiber.Map
		for langRows.Next() {
			var lang string
			var count int
			if err := langRows.Scan(&lang, &count); err != nil {
				slog.Error("failed to scan language row", "error", err)
				continue
			}
			languages = append(languages, fiber.Map{
				"language":            lang,
				"contribution_count": count,
			})
		}

		// Get most active ecosystems (top 10)
		// Count contributions per ecosystem, only for verified projects
		ecoRows, err := h.db.Pool.Query(c.Context(), `
SELECT 
  e.name as ecosystem_name,
  COUNT(*) as contribution_count
FROM (
  SELECT project_id FROM github_issues WHERE author_login = $1
  UNION ALL
  SELECT project_id FROM github_pull_requests WHERE author_login = $1
) contributions
INNER JOIN projects p ON contributions.project_id = p.id
INNER JOIN ecosystems e ON p.ecosystem_id = e.id
WHERE p.status = 'verified' AND e.status = 'active'
GROUP BY e.id, e.name
ORDER BY contribution_count DESC, e.name ASC
LIMIT 10
`, *githubLogin)
		if err != nil {
			slog.Error("failed to fetch ecosystems", "error", err, "user_id", userID, "github_login", *githubLogin)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "ecosystems_fetch_failed"})
		}
		defer ecoRows.Close()

		var ecosystems []fiber.Map
		for ecoRows.Next() {
			var ecoName string
			var count int
			if err := ecoRows.Scan(&ecoName, &count); err != nil {
				slog.Error("failed to scan ecosystem row", "error", err)
				continue
			}
			ecosystems = append(ecosystems, fiber.Map{
				"ecosystem_name":     ecoName,
				"contribution_count": count,
			})
		}

		// Get user's rank position in leaderboard
		// Use a more efficient query with CTE
		var rankPosition *int
		err = h.db.Pool.QueryRow(c.Context(), `
WITH contribution_counts AS (
  SELECT 
    ga.login,
    (
      SELECT COUNT(*) 
      FROM github_issues i
      INNER JOIN projects p ON i.project_id = p.id
      WHERE i.author_login = ga.login AND p.status = 'verified'
    ) +
    (
      SELECT COUNT(*) 
      FROM github_pull_requests pr
      INNER JOIN projects p ON pr.project_id = p.id
      WHERE pr.author_login = ga.login AND p.status = 'verified'
    ) as contribution_count
  FROM github_accounts ga
  INNER JOIN users u ON ga.user_id = u.id
  WHERE (
    SELECT COUNT(*) 
    FROM github_issues i
    INNER JOIN projects p ON i.project_id = p.id
    WHERE i.author_login = ga.login AND p.status = 'verified'
  ) +
  (
    SELECT COUNT(*) 
    FROM github_pull_requests pr
    INNER JOIN projects p ON pr.project_id = p.id
    WHERE pr.author_login = ga.login AND p.status = 'verified'
  ) > 0
),
ranked_users AS (
  SELECT 
    login,
    ROW_NUMBER() OVER (
      ORDER BY contribution_count DESC, login ASC
    ) as rank_position
  FROM contribution_counts
)
SELECT rank_position
FROM ranked_users
WHERE login = $1
`, *githubLogin).Scan(&rankPosition)

		// Calculate rank tier
		var rankTier RankTier
		var rankTierName string
		var rankTierColor string
		if rankPosition != nil && *rankPosition > 0 {
			rankTier = GetRankTier(*rankPosition)
			rankTierName = GetRankTierDisplayName(rankTier)
			rankTierColor = GetRankTierColor(rankTier)
		} else {
			// User has no contributions or not ranked
			rankTier = RankBronze
			rankTierName = GetRankTierDisplayName(rankTier)
			rankTierColor = GetRankTierColor(rankTier)
		}

		// Count distinct projects user has contributed to (via issues or PRs)
		var projectsContributedToCount int
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT COUNT(DISTINCT project_id)
FROM (
  SELECT project_id FROM github_issues WHERE author_login = $1
  UNION
  SELECT project_id FROM github_pull_requests WHERE author_login = $1
) contributions
INNER JOIN projects p ON contributions.project_id = p.id
WHERE p.status = 'verified'
`, *githubLogin).Scan(&projectsContributedToCount)
		if err != nil {
			slog.Warn("failed to count projects contributed to", "error", err, "user_id", userID, "github_login", *githubLogin)
			projectsContributedToCount = 0
		}

		// Count projects where user is a maintainer/lead
		// This checks if the user is the owner of the project (via github_full_name owner match)
		var projectsLedCount int
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT COUNT(DISTINCT p.id)
FROM projects p
WHERE p.status = 'verified' 
  AND p.deleted_at IS NULL
  AND SPLIT_PART(p.github_full_name, '/', 1) = $1
`, *githubLogin).Scan(&projectsLedCount)
		if err != nil {
			slog.Warn("failed to count projects led", "error", err, "user_id", userID, "github_login", *githubLogin)
			projectsLedCount = 0
		}

		response := fiber.Map{
			"contributions_count":         contributionsCount,
			"projects_contributed_to_count": projectsContributedToCount,
			"projects_led_count":          projectsLedCount,
			"rewards_count":              0, // TODO: Implement rewards system
			"languages":                  languages,
			"ecosystems":                 ecosystems,
			"rank": fiber.Map{
				"position":   rankPosition,
				"tier":       string(rankTier),
				"tier_name":  rankTierName,
				"tier_color": rankTierColor,
			},
		}

		return c.Status(fiber.StatusOK).JSON(response)
	}
}

// ContributionCalendar returns daily contribution counts for the last year (365 days)
// Used for rendering a GitHub-style contribution heatmap/calendar
// Returns data in format: {"date": "2024-01-15", "count": 5, "level": 3}
// where level is 0-4 (0 = no contributions, 4 = highest activity)
func (h *UserProfileHandler) ContributionCalendar() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if h.db == nil || h.db.Pool == nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "db_not_configured"})
		}

		// Get user ID from JWT
		sub, _ := c.Locals(auth.LocalUserID).(string)
		userID, err := uuid.Parse(sub)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid_user"})
		}

		// Get user's GitHub login
		var githubLogin *string
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT login
FROM github_accounts
WHERE user_id = $1
`, userID).Scan(&githubLogin)
		if err != nil || githubLogin == nil || *githubLogin == "" {
			// Return empty calendar if no GitHub account
			return c.Status(fiber.StatusOK).JSON(fiber.Map{
				"calendar": []fiber.Map{},
				"total":    0,
			})
		}

		// Calculate date range: last 365 days from today
		now := time.Now().UTC()
		startDate := now.AddDate(0, 0, -365)

		// Query daily contribution counts (issues + PRs) for verified projects
		// Use DATE_TRUNC to group by day
		rows, err := h.db.Pool.Query(c.Context(), `
SELECT 
  DATE(contribution_date) as date,
  COUNT(*) as count
FROM (
  SELECT created_at_github as contribution_date
  FROM github_issues i
  INNER JOIN projects p ON i.project_id = p.id
  WHERE i.author_login = $1 
    AND i.created_at_github >= $2 
    AND i.created_at_github <= $3
    AND p.status = 'verified'
  
  UNION ALL
  
  SELECT created_at_github as contribution_date
  FROM github_pull_requests pr
  INNER JOIN projects p ON pr.project_id = p.id
  WHERE pr.author_login = $1 
    AND pr.created_at_github >= $2 
    AND pr.created_at_github <= $3
    AND p.status = 'verified'
) contributions
GROUP BY DATE(contribution_date)
ORDER BY date ASC
`, *githubLogin, startDate, now)
		if err != nil {
			slog.Error("failed to fetch contribution calendar", "error", err, "user_id", userID, "github_login", *githubLogin)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "calendar_fetch_failed"})
		}
		defer rows.Close()

		// Build a map of date -> count for quick lookup
		dateCounts := make(map[string]int)
		totalContributions := 0
		for rows.Next() {
			var date time.Time
			var count int
			if err := rows.Scan(&date, &count); err != nil {
				slog.Error("failed to scan calendar row", "error", err)
				continue
			}
			dateStr := date.Format("2006-01-02")
			dateCounts[dateStr] = count
			totalContributions += count
		}

		// Find max count for color level calculation
		maxCount := 0
		for _, count := range dateCounts {
			if count > maxCount {
				maxCount = count
			}
		}

		// Generate calendar data for all 365 days
		// Color levels: 0 = none, 1 = low, 2 = medium, 3 = high, 4 = very high
		// Using GitHub's algorithm: levels are based on quartiles
		var calendar []fiber.Map
		currentDate := startDate
		for currentDate.Before(now) || currentDate.Equal(now.Truncate(24 * time.Hour)) {
			dateStr := currentDate.Format("2006-01-02")
			count := dateCounts[dateStr]
			
			// Calculate level (0-4) based on count
			level := calculateContributionLevel(count, maxCount)
			
			calendar = append(calendar, fiber.Map{
				"date":  dateStr,
				"count": count,
				"level": level,
			})
			
			currentDate = currentDate.AddDate(0, 0, 1)
		}

		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"calendar": calendar,
			"total":    totalContributions,
		})
	}
}

// ContributionActivity returns a paginated list of individual contributions (issues and PRs)
// Grouped by month, showing contribution type, project, title, and date
func (h *UserProfileHandler) ContributionActivity() fiber.Handler {
	return func(c *fiber.Ctx) error {
		if h.db == nil || h.db.Pool == nil {
			return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "db_not_configured"})
		}

		// Get user ID from JWT
		sub, _ := c.Locals(auth.LocalUserID).(string)
		userID, err := uuid.Parse(sub)
		if err != nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid_user"})
		}

		// Get pagination parameters
		limit := c.QueryInt("limit", 50)
		if limit > 100 {
			limit = 100 // Cap at 100 for performance
		}
		offset := c.QueryInt("offset", 0)

		// Get user's GitHub login
		var githubLogin *string
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT login
FROM github_accounts
WHERE user_id = $1
`, userID).Scan(&githubLogin)
		if err != nil || githubLogin == nil || *githubLogin == "" {
			return c.Status(fiber.StatusOK).JSON(fiber.Map{
				"activities": []fiber.Map{},
				"total":      0,
				"limit":      limit,
				"offset":     offset,
			})
		}

		// Query contributions (issues and PRs) for verified projects
		// Order by date descending (most recent first)
		rows, err := h.db.Pool.Query(c.Context(), `
SELECT 
  'issue' as contribution_type,
  i.id,
  i.number,
  i.title,
  i.url,
  i.created_at_github,
  p.github_full_name as project_name,
  p.id as project_id
FROM github_issues i
INNER JOIN projects p ON i.project_id = p.id
WHERE i.author_login = $1 AND p.status = 'verified' AND i.created_at_github IS NOT NULL

UNION ALL

SELECT 
  'pull_request' as contribution_type,
  pr.id,
  pr.number,
  pr.title,
  pr.url,
  pr.created_at_github,
  p.github_full_name as project_name,
  p.id as project_id
FROM github_pull_requests pr
INNER JOIN projects p ON pr.project_id = p.id
WHERE pr.author_login = $1 AND p.status = 'verified' AND pr.created_at_github IS NOT NULL

ORDER BY created_at_github DESC
LIMIT $2 OFFSET $3
`, *githubLogin, limit, offset)
		if err != nil {
			slog.Error("failed to fetch contribution activity", "error", err, "user_id", userID, "github_login", *githubLogin)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "activity_fetch_failed"})
		}
		defer rows.Close()

		var activities []fiber.Map
		for rows.Next() {
			var contribType string
			var id uuid.UUID
			var number int
			var title, url, projectName string
			var projectID uuid.UUID
			var createdAt *time.Time

			if err := rows.Scan(&contribType, &id, &number, &title, &url, &createdAt, &projectName, &projectID); err != nil {
				slog.Error("failed to scan activity row", "error", err)
				continue
			}

			// Format date for display
			var dateStr string
			var monthYear string
			if createdAt != nil {
				dateStr = createdAt.Format("2006-01-02")
				monthYear = createdAt.Format("January 2006")
			}

			activities = append(activities, fiber.Map{
				"type":         contribType,
				"id":           id.String(),
				"number":       number,
				"title":        title,
				"url":          url,
				"date":         dateStr,
				"month_year":   monthYear,
				"project_name": projectName,
				"project_id":   projectID.String(),
			})
		}

		// Get total count for pagination
		var total int
		err = h.db.Pool.QueryRow(c.Context(), `
SELECT 
  (SELECT COUNT(*) FROM github_issues i
   INNER JOIN projects p ON i.project_id = p.id
   WHERE i.author_login = $1 AND p.status = 'verified' AND i.created_at_github IS NOT NULL)
  +
  (SELECT COUNT(*) FROM github_pull_requests pr
   INNER JOIN projects p ON pr.project_id = p.id
   WHERE pr.author_login = $1 AND p.status = 'verified' AND pr.created_at_github IS NOT NULL)
`, *githubLogin).Scan(&total)
		if err != nil {
			slog.Error("failed to count total activities", "error", err)
			total = len(activities) // Fallback
		}

		return c.Status(fiber.StatusOK).JSON(fiber.Map{
			"activities": activities,
			"total":      total,
			"limit":     limit,
			"offset":     offset,
		})
	}
}

// calculateContributionLevel determines the color level (0-4) based on contribution count
// Uses GitHub's algorithm: levels are based on quartiles of the max count
func calculateContributionLevel(count int, maxCount int) int {
	if count == 0 {
		return 0
	}
	if maxCount == 0 {
		return 0
	}

	// Calculate quartiles
	q1 := maxCount / 4
	q2 := maxCount / 2
	q3 := (maxCount * 3) / 4

	if count <= q1 {
		return 1 // Low
	} else if count <= q2 {
		return 2 // Medium
	} else if count <= q3 {
		return 3 // High
	} else {
		return 4 // Very high
	}
}

