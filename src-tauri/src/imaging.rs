use base64::Engine;
use image::{ExtendedColorType, GenericImageView, ImageEncoder};
use std::path::Path;

/// Screenshots are commonly 2560x1440 PNGs of several megabytes. Sending that
/// untouched is slow and, on metered APIs, needlessly expensive — so everything
/// is decoded locally, downscaled and re-encoded as JPEG first.
pub fn encode_downscaled(path: &Path, max_edge: u32, quality: u8) -> Result<String, String> {
    let max_edge = max_edge.clamp(256, 4096);

    let reader = image::ImageReader::open(path)
        .map_err(|e| format!("Could not open the image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Could not read the image: {e}"))?;

    let img = reader
        .decode()
        .map_err(|e| format!("Could not decode the image: {e}"))?;

    let (w, h) = img.dimensions();
    let img = if w.max(h) > max_edge {
        img.resize(max_edge, max_edge, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    // JPEG has no alpha channel, and screenshots do not need one.
    let rgb = img.into_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());

    let mut buf: Vec<u8> = Vec::new();
    let encoder =
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality.clamp(30, 100));
    encoder
        .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
        .map_err(|e| format!("Could not encode the image: {e}"))?;

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

/// A small solid-colour image used by "Test connection", so the check proves
/// the endpoint really accepts image input rather than just chat.
pub fn test_image() -> String {
    let img = image::RgbImage::from_fn(64, 64, |x, y| {
        if (x / 16 + y / 16) % 2 == 0 {
            image::Rgb([32u8, 96u8, 220u8])
        } else {
            image::Rgb([245u8, 245u8, 245u8])
        }
    });

    let mut buf: Vec<u8> = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 85);
    let _ = encoder.write_image(img.as_raw(), 64, 64, ExtendedColorType::Rgb8);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf);
    format!("data:image/jpeg;base64,{b64}")
}
