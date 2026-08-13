//! Talks to any OpenAI-compatible `/chat/completions` endpoint.
//!
//! "OpenAI-compatible" is a loose promise — plenty of endpoints accept the
//! chat schema but reject image parts, and plenty of models on an endpoint that
//! does support images are text-only. Errors are therefore surfaced verbatim
//! rather than flattened, because the provider's own message is usually the
//! only useful clue.

use serde::Deserialize;
use std::time::Duration;

use crate::secrets;

const USER_AGENT: &str = concat!("Screenshotify/", env!("CARGO_PKG_VERSION"));

#[derive(Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct Choice {
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    content: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

#[derive(Deserialize)]
struct ModelList {
    data: Option<Vec<ModelEntry>>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: Option<String>,
}

/// Joins a user-supplied base URL with an API path, tolerating a trailing
/// slash or a base that already includes the path.
fn endpoint(base: &str, path: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("No base URL is set. Add one in Settings.".into());
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err(format!(
            "The base URL must start with http:// or https:// — got \"{base}\"."
        ));
    }
    if base.ends_with(path) {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}{path}"))
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Could not create the HTTP client: {e}"))
}

fn auth(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match secrets::get() {
        // Local servers such as Ollama accept — and ignore — any bearer token,
        // so sending nothing at all is the safer default when no key is stored.
        Some(key) => req.bearer_auth(key),
        None => req,
    }
}

/// Pulls the text out of a `content` field that may be a plain string or the
/// array-of-parts form some providers return.
fn content_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

async fn post_chat(
    base_url: &str,
    model: &str,
    prompt: &str,
    image_data_url: &str,
    max_tokens: u32,
    timeout: Duration,
) -> Result<String, String> {
    let url = endpoint(base_url, "/chat/completions")?;
    let model = model.trim();
    if model.is_empty() {
        return Err("No model is set. Add one in Settings.".into());
    }

    let body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": "You write short, specific filenames for screenshots. You reply with the filename and nothing else."
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": image_data_url, "detail": "low" } }
                ]
            }
        ]
    });

    let request = client(timeout)?
        .post(&url)
        .header("Content-Type", "application/json")
        // OpenRouter attributes traffic with these; other providers ignore them.
        .header("X-Title", "Screenshotify")
        .header("HTTP-Referer", "https://github.com/screenshotify/screenshotify")
        .json(&body);

    let response = auth(request).send().await.map_err(|e| {
        if e.is_timeout() {
            format!("The request to {url} timed out.")
        } else if e.is_connect() {
            format!("Could not connect to {url}. Is the endpoint running and the URL correct?")
        } else {
            format!("Request to {url} failed: {e}")
        }
    })?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Could not read the response: {e}"))?;

    let parsed: Option<ChatResponse> = serde_json::from_str(&text).ok();

    if !status.is_success() {
        let detail = parsed
            .as_ref()
            .and_then(|p| p.error.as_ref())
            .and_then(|e| e.message.clone())
            .unwrap_or_else(|| truncate(&text, 300));

        let hint = match status.as_u16() {
            401 | 403 => "\n\nCheck the API key in Settings.",
            404 => "\n\nCheck the base URL and the model name.",
            413 => "\n\nTry a smaller image size in Settings.",
            429 => "\n\nRate limited — lower the number of parallel requests in Settings.",
            _ => "",
        };
        return Err(format!("{status}: {detail}{hint}"));
    }

    let parsed = parsed.ok_or_else(|| {
        format!(
            "The endpoint replied with something that is not an OpenAI-style response:\n{}",
            truncate(&text, 300)
        )
    })?;

    if let Some(err) = parsed.error.and_then(|e| e.message) {
        return Err(err);
    }

    let content = parsed
        .choices
        .and_then(|c| c.into_iter().next())
        .and_then(|c| c.message)
        .and_then(|m| m.content)
        .map(|v| content_text(&v))
        .unwrap_or_default();

    if content.trim().is_empty() {
        return Err(
            "The model returned an empty answer. It may not support image input.".into(),
        );
    }

    Ok(content)
}

/// Asks the model for a filename. `image_data_url` is produced by `imaging`.
pub async fn suggest(
    base_url: &str,
    model: &str,
    prompt: &str,
    image_data_url: &str,
) -> Result<String, String> {
    post_chat(
        base_url,
        model,
        prompt,
        image_data_url,
        64,
        Duration::from_secs(120),
    )
    .await
}

/// Sends a tiny generated image so the user finds out now — not on their first
/// screenshot — whether this endpoint and model actually accept images.
pub async fn test(base_url: &str, model: &str) -> Result<String, String> {
    let image = crate::imaging::test_image();
    let reply = post_chat(
        base_url,
        model,
        "Reply with the single word OK.",
        &image,
        16,
        Duration::from_secs(60),
    )
    .await?;
    Ok(truncate(&reply, 120))
}

/// Best-effort model list for the suggestions dropdown. Many local servers
/// implement this; those that do not simply produce an error the caller shows.
pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let url = endpoint(base_url, "/models")?;
    let request = client(Duration::from_secs(20)).map(|c| c.get(&url))?;

    let response = auth(request)
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("Could not read the response: {e}"))?;

    if !status.is_success() {
        return Err(format!("{status}: {}", truncate(&text, 200)));
    }

    let list: ModelList = serde_json::from_str(&text)
        .map_err(|_| format!("Unexpected response from {url}: {}", truncate(&text, 200)))?;

    let mut models: Vec<String> = list
        .data
        .unwrap_or_default()
        .into_iter()
        .filter_map(|m| m.id)
        .collect();
    models.sort();
    Ok(models)
}
