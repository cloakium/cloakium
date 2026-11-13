/// A text file modelled as lines so hunks can be applied without re-parsing
/// the whole file for every patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Document {
    lines: Vec<String>,
    ends_with_newline: bool,
}

impl Document {
    pub fn parse(text: &str) -> Self {
        let ends_with_newline = text.ends_with('\n');
        let mut lines: Vec<String> = text.split('\n').map(|line| line.to_string()).collect();
        if ends_with_newline {
            lines.pop();
        }
        if text.is_empty() {
            lines.clear();
        }
        Self {
            lines,
            ends_with_newline,
        }
    }

    pub fn render(&self) -> String {
        let mut out = self.lines.join("\n");
        if self.ends_with_newline && !self.lines.is_empty() {
            out.push('\n');
        }
        out
    }

    pub fn line_count(&self) -> usize {
        self.lines.len()
    }

    pub fn line(&self, index: usize) -> Option<&str> {
        self.lines.get(index).map(String::as_str)
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    pub fn insert_lines(&mut self, index: usize, new_lines: &[&str]) {
        let tail = self.lines.split_off(index);
        self.lines
            .extend(new_lines.iter().map(|line| (*line).to_string()));
        self.lines.extend(tail);
    }

    pub fn remove_lines(&mut self, index: usize, count: usize) {
        self.lines.drain(index..index + count);
    }
}

#[cfg(test)]
mod tests {
    use super::Document;

    #[test]
    fn roundtrips_text() {
        for text in ["", "a", "a\n", "a\nb", "a\nb\n", "a\n\nb\n"] {
            assert_eq!(Document::parse(text).render(), text, "text {text:?}");
        }
    }

    #[test]
    fn counts_lines() {
        assert_eq!(Document::parse("").line_count(), 0);
        assert_eq!(Document::parse("a").line_count(), 1);
        assert_eq!(Document::parse("a\n").line_count(), 1);
        assert_eq!(Document::parse("a\nb\n").line_count(), 2);
    }
}
