use crate::apply::Report;

/// Name of the provenance file written next to the patched package.
pub const MANIFEST_FILE: &str = "CLOAKIUM-PATCHES.json";

/// Render the patch manifest as deterministic JSON.
///
/// Determinism matters: the file is committed by the updater and compared in
/// CI, so there are no timestamps, no host names and no unordered maps.
pub fn render(patch_set: &str, report: &Report) -> String {
    let mut out = String::new();
    out.push_str("{\n");
    out.push_str("  \"format\": 1,\n");
    out.push_str("  \"tool\": \"playwright-patcher\",\n");
    out.push_str(&format!("  \"patchSet\": {},\n", quote(patch_set)));
    out.push_str("  \"patches\": [\n");
    for (index, patch) in report.patches.iter().enumerate() {
        let comma = if index + 1 == report.patches.len() {
            ""
        } else {
            ","
        };
        out.push_str(&format!(
            "    {{ \"name\": {}, \"sha256\": {}, \"target\": {} }}{comma}\n",
            quote(&patch.name),
            quote(&patch.sha256),
            quote(&patch.file.target)
        ));
    }
    out.push_str("  ],\n");
    out.push_str("  \"files\": [\n");
    for (index, file) in report.files.iter().enumerate() {
        let comma = if index + 1 == report.files.len() {
            ""
        } else {
            ","
        };
        out.push_str(&format!(
            "    {{ \"path\": {}, \"sha256Before\": {}, \"sha256After\": {} }}{comma}\n",
            quote(&file.path),
            quote(&file.sha256_before),
            quote(&file.sha256_after)
        ));
    }
    out.push_str("  ],\n");
    match &report.marker {
        Some(marker) => {
            out.push_str("  \"marker\": {\n");
            out.push_str(&format!("    \"file\": {},\n", quote(&marker.file)));
            out.push_str(&format!("    \"package\": {},\n", quote(&marker.package)));
            out.push_str(&format!("    \"version\": {},\n", quote(&marker.version)));
            out.push_str(&format!(
                "    \"patchSet\": {},\n",
                quote(&marker.patch_set)
            ));
            out.push_str(&format!("    \"source\": {}\n", quote(&marker.source)));
            out.push_str("  }\n");
        }
        None => out.push_str("  \"marker\": null\n"),
    }
    out.push_str("}\n");
    out
}

fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn escapes_strings() {
        assert_eq!(quote("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
        assert_eq!(quote("plain/path.js"), "\"plain/path.js\"");
    }
}
