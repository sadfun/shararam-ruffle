//! In-flight SWF patching that strips visual filters and `cacheAsBitmap`.
//!
//! Why: Shararam's art relies heavily on timeline filters (GlowFilter,
//! DropShadowFilter, …). In Flash and Ruffle alike, *any* filter on a clip
//! forces the subtree into an offscreen bitmap cache; when the clip animates,
//! the cache is redrawn — and when its pixel bounds change, the cache texture
//! is reallocated — every frame. A profiled live session showed ~13,000
//! texture allocations in five minutes, all traced to filtered clips
//! (avatar-sized, 30–65×110–119 px). The game's sources are lost, so the fix
//! is applied to the SWF bytes as they stream through the local proxy.
//!
//! The patch does three things:
//! 1. `PlaceObject3`: removes the surface filter list and clears
//!    `HAS_FILTER_LIST`.
//! 2. `PlaceObject3`: forces the `cacheAsBitmap` byte to 0, which parsers
//!    read as an explicit "do not cache".
//! 3. AVM1 bytecode: renames the exact property strings `filters` and
//!    `cacheAsBitmap` to same-length inert names, so dynamic
//!    `clip.filters = [glow]` assignments become harmless expando writes.
//!    Same-length replacement keeps every bytecode offset valid. Qualified
//!    class paths (`flash.filters.GlowFilter`) are left intact: constructing
//!    a filter object is harmless once it can no longer be applied.
//!
//! Every step is fail-open: a tag that does not parse exactly as expected is
//! copied through unchanged (counted in `skipped_tags`), and a file that is
//! not a supported SWF — or where nothing changed — is served untouched.

use std::io::{Read, Write};
use std::sync::OnceLock;

/// Opt-in switch: `SHARARAM_SWF_PATCH=1` strips filters/cacheAsBitmap
/// in-flight. Off by default: with Layer groups now rendered inline by the
/// Ruffle fork, filter-driven bitmap caching is a net win again — cached
/// avatars draw as a few quads instead of ~100 re-filled vector shapes per
/// frame, and the glow/shadow art comes back. The strip stays available for
/// A/B runs.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        matches!(
            std::env::var("SHARARAM_SWF_PATCH").as_deref(),
            Ok("1") | Ok("true") | Ok("on") | Ok("yes")
        )
    })
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PatchStats {
    /// `PlaceObject3` surface filter lists spliced out.
    pub filter_lists: u32,
    /// Individual filters inside those lists.
    pub filters: u32,
    /// `PlaceObject3` cacheAsBitmap values forced to "off".
    pub cache_flags: u32,
    /// AVM1 identifier occurrences renamed.
    pub renames: u32,
    /// Tags left untouched because they did not parse as expected.
    pub skipped_tags: u32,
}

impl PatchStats {
    pub fn changed(&self) -> bool {
        self.filter_lists > 0 || self.cache_flags > 0 || self.renames > 0
    }

    pub fn summary(&self) -> String {
        format!(
            "filter_lists={} filters={} cache_flags={} renames={} skipped_tags={}",
            self.filter_lists, self.filters, self.cache_flags, self.renames, self.skipped_tags
        )
    }
}

/// Patches a complete SWF. Returns `None` when the input is not a supported
/// SWF or when nothing needed changing (serve the original bytes then).
pub fn patch_swf(input: &[u8]) -> Option<(Vec<u8>, PatchStats)> {
    if input.len() < 8 {
        return None;
    }
    let compressed = match &input[..3] {
        b"FWS" => false,
        b"CWS" => true,
        // ZWS (LZMA) is not produced by Shararam's pipeline; leave untouched.
        _ => return None,
    };
    let version = input[3];
    let body = if compressed {
        let mut out = Vec::new();
        let mut decoder = flate2::read::ZlibDecoder::new(&input[8..]);
        decoder.read_to_end(&mut out).ok()?;
        out
    } else {
        input[8..].to_vec()
    };
    let header_len = movie_header_len(&body)?;
    let mut stats = PatchStats::default();
    let patched_tags = patch_tag_stream(&body[header_len..], &mut stats)?;
    if !stats.changed() {
        return None;
    }
    let mut new_body = body[..header_len].to_vec();
    new_body.extend_from_slice(&patched_tags);
    let mut out = Vec::with_capacity(input.len());
    out.extend_from_slice(&input[..3]);
    out.push(version);
    out.extend_from_slice(&(8u32 + new_body.len() as u32).to_le_bytes());
    if compressed {
        // Local transfer: favor compression speed over size.
        let mut encoder = flate2::write::ZlibEncoder::new(&mut out, flate2::Compression::fast());
        encoder.write_all(&new_body).ok()?;
        encoder.finish().ok()?;
    } else {
        out.extend_from_slice(&new_body);
    }
    Some((out, stats))
}

/// Movie header after the 8-byte file header: RECT + frame rate + frame count.
fn movie_header_len(body: &[u8]) -> Option<usize> {
    let first = *body.first()?;
    let nbits = (first >> 3) as usize;
    let rect_len = (5 + nbits * 4).div_ceil(8);
    let total = rect_len + 4;
    (body.len() >= total).then_some(total)
}

const TAG_END: u16 = 0;
const TAG_DO_ACTION: u16 = 12;
const TAG_PLACE_OBJECT_2: u16 = 26;
const TAG_DEFINE_BUTTON_2: u16 = 34;
const TAG_DEFINE_SPRITE: u16 = 39;
const TAG_DO_INIT_ACTION: u16 = 59;
const TAG_PLACE_OBJECT_3: u16 = 70;

fn patch_tag_stream(mut tags: &[u8], stats: &mut PatchStats) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(tags.len());
    while tags.len() >= 2 {
        let code_and_length = u16::from_le_bytes([tags[0], tags[1]]);
        let code = code_and_length >> 6;
        let mut length = (code_and_length & 0x3f) as usize;
        let mut header = 2;
        if length == 0x3f {
            if tags.len() < 6 {
                return None;
            }
            length = u32::from_le_bytes([tags[2], tags[3], tags[4], tags[5]]) as usize;
            header = 6;
        }
        if tags.len() < header + length {
            // Truncated tag stream: refuse to patch the whole file.
            return None;
        }
        let tag = &tags[header..header + length];
        let new_tag: Option<Vec<u8>> = match code {
            TAG_PLACE_OBJECT_3 => {
                let structural = patch_place_object3(tag, stats);
                // Clip actions at the tag's end may also contain AVM1 strings.
                match rename_avm1_identifiers(structural.as_deref().unwrap_or(tag), stats) {
                    Some(renamed) => Some(renamed),
                    None => structural,
                }
            }
            TAG_DEFINE_SPRITE if length >= 4 => {
                let before = *stats;
                match patch_tag_stream(&tag[4..], stats) {
                    Some(nested) if *stats != before => {
                        let mut buf = tag[..4].to_vec();
                        buf.extend_from_slice(&nested);
                        Some(buf)
                    }
                    // Unchanged or failed: keep the original bytes either way.
                    _ => None,
                }
            }
            TAG_DO_ACTION | TAG_PLACE_OBJECT_2 | TAG_DEFINE_BUTTON_2 | TAG_DO_INIT_ACTION => {
                rename_avm1_identifiers(tag, stats)
            }
            _ => None,
        };
        match new_tag {
            Some(bytes) => emit_tag(&mut out, code, &bytes),
            None => out.extend_from_slice(&tags[..header + length]),
        }
        tags = &tags[header + length..];
        if code == TAG_END {
            break;
        }
    }
    // Preserve any trailing bytes after the End tag verbatim.
    out.extend_from_slice(tags);
    Some(out)
}

fn emit_tag(out: &mut Vec<u8>, code: u16, body: &[u8]) {
    if body.len() < 0x3f {
        out.extend_from_slice(&((code << 6) | body.len() as u16).to_le_bytes());
    } else {
        out.extend_from_slice(&((code << 6) | 0x3f).to_le_bytes());
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    }
    out.extend_from_slice(body);
}

/// Same-length renames applied to AVM1-bearing tags. `filters` must stay a
/// valid identifier so the game's own reads/writes remain self-consistent.
const RENAMES: &[(&[u8], &[u8])] = &[
    (b"cacheAsBitmap", b"cacheAsB1tmap"),
    (b"filters", b"f1lters"),
];

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte == b'.'
}

/// Renames exact NUL-terminated identifier strings in-place (same length, so
/// every bytecode offset stays valid). Returns `None` when nothing matched.
fn rename_avm1_identifiers(tag: &[u8], stats: &mut PatchStats) -> Option<Vec<u8>> {
    let mut out: Option<Vec<u8>> = None;
    for &(from, to) in RENAMES {
        debug_assert_eq!(from.len(), to.len());
        let mut matches = Vec::new();
        {
            let hay: &[u8] = out.as_deref().unwrap_or(tag);
            let mut i = 0;
            while i + from.len() < hay.len() {
                if hay[i..].starts_with(from)
                    && hay[i + from.len()] == 0
                    && (i == 0 || !is_identifier_byte(hay[i - 1]))
                {
                    matches.push(i);
                    i += from.len();
                } else {
                    i += 1;
                }
            }
        }
        if !matches.is_empty() {
            let buf = out.get_or_insert_with(|| tag.to_vec());
            for at in matches {
                buf[at..at + to.len()].copy_from_slice(to);
                stats.renames += 1;
            }
        }
    }
    out
}

mod place_flags {
    pub const HAS_CHARACTER: u16 = 1 << 1;
    pub const HAS_MATRIX: u16 = 1 << 2;
    pub const HAS_COLOR_TRANSFORM: u16 = 1 << 3;
    pub const HAS_RATIO: u16 = 1 << 4;
    pub const HAS_NAME: u16 = 1 << 5;
    pub const HAS_CLIP_DEPTH: u16 = 1 << 6;
    pub const HAS_FILTER_LIST: u16 = 1 << 8;
    pub const HAS_BLEND_MODE: u16 = 1 << 9;
    pub const HAS_CACHE_AS_BITMAP: u16 = 1 << 10;
    pub const HAS_CLASS_NAME: u16 = 1 << 11;
    pub const HAS_IMAGE: u16 = 1 << 12;
}

fn patch_place_object3(tag: &[u8], stats: &mut PatchStats) -> Option<Vec<u8>> {
    match try_patch_place_object3(tag) {
        Ok(result) => {
            if let Some((_, lists, filters, cache)) = &result {
                stats.filter_lists += lists;
                stats.filters += filters;
                stats.cache_flags += cache;
            }
            result.map(|(bytes, _, _, _)| bytes)
        }
        Err(()) => {
            stats.skipped_tags += 1;
            None
        }
    }
}

type PlacePatch = (Vec<u8>, u32, u32, u32);

fn try_patch_place_object3(tag: &[u8]) -> Result<Option<PlacePatch>, ()> {
    use place_flags::*;
    let mut cursor = Cursor { data: tag, pos: 0 };
    let flags = cursor.u16()?;
    if flags & (HAS_FILTER_LIST | HAS_CACHE_AS_BITMAP) == 0 {
        return Ok(None);
    }
    cursor.skip(2)?; // depth
    let has_image = flags & HAS_IMAGE != 0;
    let has_character = flags & HAS_CHARACTER != 0;
    // Matches Ruffle's reader: class name is present with HAS_CLASS_NAME or
    // with HAS_IMAGE when no character id follows.
    if flags & HAS_CLASS_NAME != 0 || (has_image && !has_character) {
        cursor.skip_cstr()?;
    }
    if has_character {
        cursor.skip(2)?;
    }
    if flags & HAS_MATRIX != 0 {
        cursor.skip_matrix()?;
    }
    if flags & HAS_COLOR_TRANSFORM != 0 {
        cursor.skip_color_transform()?;
    }
    if flags & HAS_RATIO != 0 {
        cursor.skip(2)?;
    }
    if flags & HAS_NAME != 0 {
        cursor.skip_cstr()?;
    }
    if flags & HAS_CLIP_DEPTH != 0 {
        cursor.skip(2)?;
    }
    let filter_start = cursor.pos;
    let mut filters_removed = 0u32;
    if flags & HAS_FILTER_LIST != 0 {
        let count = cursor.u8()?;
        for _ in 0..count {
            cursor.skip_filter()?;
        }
        filters_removed = u32::from(count);
    }
    let filter_end = cursor.pos;
    if flags & HAS_BLEND_MODE != 0 {
        cursor.skip(1)?;
    }
    // Some encoders end the tag right at the cacheAsBitmap flag without the
    // expected value byte; parsers then read it as `true`.
    let cache_value_pos = if flags & HAS_CACHE_AS_BITMAP != 0 && cursor.pos < tag.len() {
        Some(cursor.pos)
    } else {
        None
    };
    // Remaining fields (visible, background color, clip actions) are copied
    // through verbatim; they sit after everything we modify.

    let mut new_flags = flags & !HAS_FILTER_LIST;
    let mut cache_cleared = 0u32;
    if flags & HAS_CACHE_AS_BITMAP != 0 && cache_value_pos.is_none() {
        // Truncated form: clearing the flag is the only way to disable it.
        new_flags &= !HAS_CACHE_AS_BITMAP;
        cache_cleared = 1;
    }
    let lists_removed = u32::from(flags & HAS_FILTER_LIST != 0);
    let removed = filter_end - filter_start;
    let mut out = Vec::with_capacity(tag.len() - removed);
    out.extend_from_slice(&new_flags.to_le_bytes());
    out.extend_from_slice(&tag[2..filter_start]);
    out.extend_from_slice(&tag[filter_end..]);
    if let Some(pos) = cache_value_pos {
        let index = pos - removed;
        if out[index] != 0 {
            out[index] = 0;
            cache_cleared = 1;
        }
    }
    if lists_removed == 0 && cache_cleared == 0 {
        return Ok(None);
    }
    Ok(Some((out, lists_removed, filters_removed, cache_cleared)))
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Cursor<'_> {
    fn u8(&mut self) -> Result<u8, ()> {
        let value = *self.data.get(self.pos).ok_or(())?;
        self.pos += 1;
        Ok(value)
    }

    fn u16(&mut self) -> Result<u16, ()> {
        let bytes = self.data.get(self.pos..self.pos + 2).ok_or(())?;
        self.pos += 2;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    fn skip(&mut self, n: usize) -> Result<(), ()> {
        if self.pos + n > self.data.len() {
            return Err(());
        }
        self.pos += n;
        Ok(())
    }

    fn skip_cstr(&mut self) -> Result<(), ()> {
        let nul = self.data[self.pos..]
            .iter()
            .position(|&b| b == 0)
            .ok_or(())?;
        self.pos += nul + 1;
        Ok(())
    }

    fn skip_matrix(&mut self) -> Result<(), ()> {
        let mut bits = BitCursor::new(self);
        if bits.bit()? {
            let n = bits.ubits(5)?;
            bits.skip_bits(2 * n)?;
        }
        if bits.bit()? {
            let n = bits.ubits(5)?;
            bits.skip_bits(2 * n)?;
        }
        let n = bits.ubits(5)?;
        bits.skip_bits(2 * n)?;
        let consumed = bits.consumed_bytes();
        self.skip(consumed)
    }

    fn skip_color_transform(&mut self) -> Result<(), ()> {
        let mut bits = BitCursor::new(self);
        let has_add = bits.bit()?;
        let has_mult = bits.bit()?;
        let n = bits.ubits(4)?;
        let terms = (usize::from(has_add) + usize::from(has_mult)) * 4;
        bits.skip_bits(terms * n)?;
        let consumed = bits.consumed_bytes();
        self.skip(consumed)
    }

    fn skip_filter(&mut self) -> Result<(), ()> {
        match self.u8()? {
            0 => self.skip(23), // DropShadowFilter
            1 => self.skip(9),  // BlurFilter
            2 => self.skip(15), // GlowFilter
            3 => self.skip(27), // BevelFilter
            4 | 7 => {
                // GradientGlowFilter / GradientBevelFilter
                let colors = usize::from(self.u8()?);
                self.skip(colors * 5 + 19)
            }
            5 => {
                // ConvolutionFilter
                let cols = usize::from(self.u8()?);
                let rows = usize::from(self.u8()?);
                self.skip(13 + cols * rows * 4)
            }
            6 => self.skip(80), // ColorMatrixFilter
            _ => Err(()),
        }
    }
}

struct BitCursor<'a> {
    data: &'a [u8],
    base: usize,
    bit: usize,
}

impl<'a> BitCursor<'a> {
    fn new(cursor: &Cursor<'a>) -> Self {
        BitCursor {
            data: cursor.data,
            base: cursor.pos,
            bit: 0,
        }
    }

    fn bit(&mut self) -> Result<bool, ()> {
        let byte = *self.data.get(self.base + self.bit / 8).ok_or(())?;
        let value = (byte >> (7 - self.bit % 8)) & 1;
        self.bit += 1;
        Ok(value != 0)
    }

    fn ubits(&mut self, n: usize) -> Result<usize, ()> {
        let mut value = 0usize;
        for _ in 0..n {
            value = (value << 1) | usize::from(self.bit()?);
        }
        Ok(value)
    }

    fn skip_bits(&mut self, n: usize) -> Result<(), ()> {
        self.bit += n;
        if self.base + self.bit.div_ceil(8) > self.data.len() {
            return Err(());
        }
        Ok(())
    }

    fn consumed_bytes(&self) -> usize {
        self.bit.div_ceil(8)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PlaceObject3: character 5 at depth 1, identity matrix, name "glow",
    /// one GlowFilter, cacheAsBitmap = 1.
    fn place_object3() -> Vec<u8> {
        let flags: u16 = place_flags::HAS_CHARACTER
            | place_flags::HAS_MATRIX
            | place_flags::HAS_NAME
            | place_flags::HAS_FILTER_LIST
            | place_flags::HAS_CACHE_AS_BITMAP;
        let mut tag = flags.to_le_bytes().to_vec();
        tag.extend_from_slice(&1u16.to_le_bytes()); // depth
        tag.extend_from_slice(&5u16.to_le_bytes()); // character id
        tag.push(0x00); // matrix: no scale, no rotate, 0 translate bits
        tag.extend_from_slice(b"glow\0");
        tag.push(1); // one filter
        tag.push(2); // GlowFilter
        tag.extend_from_slice(&[0u8; 15]);
        tag.push(1); // cacheAsBitmap = on
        tag
    }

    fn do_action_with_constant_pool() -> Vec<u8> {
        let pool: &[u8] = b"filters\0cacheAsBitmap\0myfilters\0";
        let mut tag = vec![0x88]; // ActionConstantPool
        tag.extend_from_slice(&((pool.len() + 2) as u16).to_le_bytes());
        tag.extend_from_slice(&3u16.to_le_bytes());
        tag.extend_from_slice(pool);
        tag.push(0x00); // ActionEnd
        tag
    }

    fn tag(code: u16, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        emit_tag(&mut out, code, body);
        out
    }

    fn movie(tags: &[Vec<u8>]) -> Vec<u8> {
        let mut body = vec![0x00]; // RECT with nbits = 0
        body.extend_from_slice(&0x0c00u16.to_le_bytes()); // frame rate
        body.extend_from_slice(&1u16.to_le_bytes()); // frame count
        for tag in tags {
            body.extend_from_slice(tag);
        }
        body.extend_from_slice(&tag(TAG_END, &[]));
        let mut swf = b"FWS".to_vec();
        swf.push(8);
        swf.extend_from_slice(&(8 + body.len() as u32).to_le_bytes());
        swf.extend_from_slice(&body);
        swf
    }

    fn parse_tags(mut tags: &[u8]) -> Vec<(u16, Vec<u8>)> {
        let mut out = Vec::new();
        while tags.len() >= 2 {
            let code_and_length = u16::from_le_bytes([tags[0], tags[1]]);
            let code = code_and_length >> 6;
            let mut length = (code_and_length & 0x3f) as usize;
            let mut header = 2;
            if length == 0x3f {
                length = u32::from_le_bytes([tags[2], tags[3], tags[4], tags[5]]) as usize;
                header = 6;
            }
            out.push((code, tags[header..header + length].to_vec()));
            tags = &tags[header + length..];
            if code == TAG_END {
                break;
            }
        }
        assert!(tags.is_empty(), "trailing bytes after End tag");
        out
    }

    #[test]
    fn strips_filters_and_cache_flag_from_place_object3() {
        let swf = movie(&[tag(TAG_PLACE_OBJECT_3, &place_object3())]);
        let (patched, stats) = patch_swf(&swf).expect("patch applies");
        assert_eq!(stats.filter_lists, 1);
        assert_eq!(stats.filters, 1);
        assert_eq!(stats.cache_flags, 1);
        assert_eq!(stats.skipped_tags, 0);
        let tags = parse_tags(&patched[8 + 5..]);
        let (code, body) = &tags[0];
        assert_eq!(*code, TAG_PLACE_OBJECT_3);
        let flags = u16::from_le_bytes([body[0], body[1]]);
        assert_eq!(flags & place_flags::HAS_FILTER_LIST, 0);
        assert_ne!(flags & place_flags::HAS_CACHE_AS_BITMAP, 0);
        assert_eq!(*body.last().unwrap(), 0, "cacheAsBitmap byte cleared");
        assert_eq!(body.len(), place_object3().len() - 17);
        // header length field matches
        let expected = u32::from_le_bytes([patched[4], patched[5], patched[6], patched[7]]);
        assert_eq!(expected as usize, patched.len());
    }

    #[test]
    fn patches_nested_sprite_tags() {
        let mut sprite = 7u16.to_le_bytes().to_vec();
        sprite.extend_from_slice(&1u16.to_le_bytes());
        sprite.extend_from_slice(&tag(TAG_PLACE_OBJECT_3, &place_object3()));
        sprite.extend_from_slice(&tag(TAG_END, &[]));
        let swf = movie(&[tag(TAG_DEFINE_SPRITE, &sprite)]);
        let (patched, stats) = patch_swf(&swf).expect("patch applies");
        assert_eq!(stats.filter_lists, 1);
        let tags = parse_tags(&patched[8 + 5..]);
        assert_eq!(tags[0].0, TAG_DEFINE_SPRITE);
        let nested = parse_tags(&tags[0].1[4..]);
        let flags = u16::from_le_bytes([nested[0].1[0], nested[0].1[1]]);
        assert_eq!(flags & place_flags::HAS_FILTER_LIST, 0);
    }

    #[test]
    fn renames_avm1_property_strings_only_on_exact_match() {
        let swf = movie(&[tag(TAG_DO_ACTION, &do_action_with_constant_pool())]);
        let (patched, stats) = patch_swf(&swf).expect("patch applies");
        assert_eq!(stats.renames, 2);
        let tags = parse_tags(&patched[8 + 5..]);
        let body = &tags[0].1;
        let find = |needle: &[u8]| body.windows(needle.len()).any(|w| w == needle);
        assert!(find(b"f1lters\0"));
        assert!(find(b"cacheAsB1tmap\0"));
        // substring of a longer identifier stays untouched
        assert!(find(b"myfilters\0"));
        assert!(!find(b"myf1lters\0"));
    }

    #[test]
    fn qualified_class_paths_stay_intact() {
        let pool: &[u8] = b"flash.filters.GlowFilter\0";
        let mut action = vec![0x88];
        action.extend_from_slice(&((pool.len() + 2) as u16).to_le_bytes());
        action.extend_from_slice(&1u16.to_le_bytes());
        action.extend_from_slice(pool);
        action.push(0x00);
        let swf = movie(&[tag(TAG_DO_ACTION, &action)]);
        assert!(patch_swf(&swf).is_none(), "nothing to change");
    }

    #[test]
    fn cws_roundtrip_produces_equivalent_body() {
        let fws = movie(&[tag(TAG_PLACE_OBJECT_3, &place_object3())]);
        let mut cws = b"CWS".to_vec();
        cws.push(8);
        cws.extend_from_slice(&fws[4..8]);
        let mut encoder = flate2::write::ZlibEncoder::new(&mut cws, flate2::Compression::best());
        encoder.write_all(&fws[8..]).unwrap();
        encoder.finish().unwrap();

        let (patched_fws, _) = patch_swf(&fws).expect("fws patch applies");
        let (patched_cws, _) = patch_swf(&cws).expect("cws patch applies");
        assert_eq!(&patched_cws[..3], b"CWS");
        let mut body = Vec::new();
        flate2::read::ZlibDecoder::new(&patched_cws[8..])
            .read_to_end(&mut body)
            .unwrap();
        assert_eq!(body, patched_fws[8..]);
        let expected = u32::from_le_bytes(patched_cws[4..8].try_into().unwrap());
        assert_eq!(expected as usize, 8 + body.len());
    }

    #[test]
    fn patching_is_idempotent() {
        let swf = movie(&[
            tag(TAG_PLACE_OBJECT_3, &place_object3()),
            tag(TAG_DO_ACTION, &do_action_with_constant_pool()),
        ]);
        let (patched, _) = patch_swf(&swf).expect("patch applies");
        assert!(patch_swf(&patched).is_none(), "second pass changes nothing");
    }

    #[test]
    fn rejects_non_swf_and_truncated_input() {
        assert!(patch_swf(b"").is_none());
        assert!(patch_swf(b"PNG whatever").is_none());
        assert!(patch_swf(b"ZWS\x0d\x00\x00\x00\x00rest").is_none());
        // truncated tag stream must refuse the whole file
        let swf = movie(&[tag(TAG_PLACE_OBJECT_3, &place_object3())]);
        assert!(patch_swf(&swf[..swf.len() - 6]).is_none());
    }

    #[test]
    fn unpatchable_place_object3_is_kept_verbatim() {
        // HAS_FILTER_LIST with an invalid filter type: tag must be kept as-is.
        let flags: u16 = place_flags::HAS_CHARACTER | place_flags::HAS_FILTER_LIST;
        let mut bad = flags.to_le_bytes().to_vec();
        bad.extend_from_slice(&1u16.to_le_bytes());
        bad.extend_from_slice(&5u16.to_le_bytes());
        bad.push(1);
        bad.push(0xff); // invalid filter type
        let swf = movie(&[tag(TAG_PLACE_OBJECT_3, &bad)]);
        assert!(
            patch_swf(&swf).is_none(),
            "sole tag skipped, nothing changed"
        );
    }

    /// Run against real downloaded SWFs: `SWF_PATCH_REAL_DIR=… cargo test
    /// --features … real_files -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs SWF_PATCH_REAL_DIR pointing at downloaded game SWFs"]
    fn real_files() {
        let dir = std::env::var("SWF_PATCH_REAL_DIR").expect("SWF_PATCH_REAL_DIR not set");
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("swf") {
                continue;
            }
            let bytes = std::fs::read(&path).unwrap();
            match patch_swf(&bytes) {
                Some((patched, stats)) => {
                    println!(
                        "{}: {} -> {} bytes, {}",
                        path.file_name().unwrap().to_string_lossy(),
                        bytes.len(),
                        patched.len(),
                        stats.summary()
                    );
                    if let Ok(dump) = std::env::var("SWF_PATCH_DUMP_DIR") {
                        let out = std::path::Path::new(&dump).join(path.file_name().unwrap());
                        std::fs::write(out, &patched).unwrap();
                    }
                    assert!(stats.changed());
                    assert!(patch_swf(&patched).is_none(), "{path:?} not idempotent");
                }
                None => println!("{}: unchanged", path.file_name().unwrap().to_string_lossy()),
            }
        }
    }
}
