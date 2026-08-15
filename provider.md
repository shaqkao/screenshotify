# Getting a free API key

Screenshotify needs a vision-capable, OpenAI-compatible endpoint. Providers
below have a free tier that works well for this — screenshots are downscaled
before upload, and a filename suggestion only needs a handful of tokens, so
free-tier rate limits go a long way.

Once you have a key, put it in **Settings → AI provider**: paste the **Base
URL** and **API key**, type the **Model**, then click **Test connection**.

## Mistral AI

1. Go to [console.mistral.ai](https://console.mistral.ai/) and sign up (email
   or Google/Microsoft SSO).
> You may see this "Looks like something went wrong!" when signing up, reload the page and it should be fine.

<p align="center"><img src="https://i.postimg.cc/hj4gn0wB/image.png" alt="image.png"></p>

2. Open **API Keys** in the left sidebar → **Create new key**. Copy it
   immediately; Mistral only shows it once.
<table align="center">
<tr>
<td><img src="https://i.postimg.cc/tCkcQjbb/image.png" width="400" alt="image.png"></td>
<td><img src="https://i.postimg.cc/NMt8jK7Q/image.png" width="400" alt="image.png"></td>
</tr>
<tr>
<td><img src="https://i.postimg.cc/8CmJwtWb/image.png" width="400" alt="image.png"></td>
<td><img src="https://i.postimg.cc/P5h8DgvV/image.png" width="400" alt="image.png"></td>
</tr>
</table>

3. In Screenshotify Settings:
   - **Base URL:** `https://api.mistral.ai/v1`
   - **Model:** `mistral-medium-latest` (recommended)
   - **API key:** the key from step 2
   - Press `test connection` to test
<p align="center"><img src="https://i.postimg.cc/3Jkt6DL5/image.png" alt="image.png"></p>

### Limit
- 25000 tokens per minute, 50 requests per minute
> Free quota may change in the future, check the latest limits at [admin.mistral.ai](https://admin.mistral.ai/plateforme/limits)

## NVIDIA (required phone number)

1. Go to [build.nvidia.com](https://build.nvidia.com/) and sign up an account
2. Open any model page, and click **Get API Key**.
> For example, use [Google DiffusionGemma](https://build.nvidia.com/google/diffusiongemma-26b-a4b-it), scroll down to **Step 1**, **Get API Key** button, and then copy it.

<p align="center"><img src="https://i.postimg.cc/QMNhZ3Hj/image.png" alt="image.png"></p>

3. Copy the key — it starts with `nvapi-`.
4. In Screenshotify Settings:
   - **Base URL:** `https://integrate.api.nvidia.com/v1`
   - **Model:** `google/diffusiongemma-26b-a4b-it`
   - **API key:** the key from step 3
<p align="center"><img src="https://i.postimg.cc/L4xPc95k/image.png" alt="image.png"></p>

### Limit
- 40 requests per minute
> Free quota may change in the future, check the latest limits at their official website.

## Notes

- Both of these are moving targets: providers change free tier terms,
  required verification steps, and model names over time. If a step above no
  longer matches what you see on the provider's site, follow their site; the
  Base URL / Model values are the part Screenshotify actually needs.
- You can always use any other models that support image input.
