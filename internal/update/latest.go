package update

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// LatestVersion resolves the tag_name of the given "owner/repo" GitHub
// repository's latest release. Used by the `klogs update` CLI command,
// which - unlike the web UI - has no browser making its own direct,
// unauthenticated call to the GitHub API.
func LatestVersion(repo string) (string, error) {
	resp, err := http.Get(fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo))
	if err != nil {
		return "", fmt.Errorf("checking latest release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checking latest release: unexpected status %d", resp.StatusCode)
	}

	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("parsing latest release response: %w", err)
	}
	if body.TagName == "" {
		return "", fmt.Errorf("latest release response had no tag_name")
	}
	return body.TagName, nil
}
