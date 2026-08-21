//! Fetches a public repo's star count from GitHub's REST API for the
//! Settings "Star on GitHub" button. No auth needed — the repo is public —
//! but GitHub rejects requests with no `User-Agent`.

use serde::Deserialize;
use std::time::Duration;

const USER_AGENT: &str = concat!("Screenshotify/", env!("CARGO_PKG_VERSION"));

#[derive(Deserialize)]
struct Repo {
    stargazers_count: u64,
}

pub async fn repo_stars(owner: &str, repo: &str) -> Result<u64, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Could not create the HTTP client: {e}"))?;

    let response = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub API returned {status}"));
    }

    let repo: Repo = response
        .json()
        .await
        .map_err(|e| format!("Unexpected response from {url}: {e}"))?;
    Ok(repo.stargazers_count)
}
