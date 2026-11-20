//! Minimal flat JSON: enough to emit and re-read the display manifest without
//! any dependency. Unknown keys are preserved by the parser and ignored by the
//! manifest reader; wrong types are rejected.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_u32(&self) -> Option<u32> {
        match self {
            Json::Num(n) if *n >= 0 && *n <= u32::MAX as i64 => Some(*n as u32),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn parse(text: &str) -> Result<Json, String> {
        let bytes = text.trim().as_bytes();
        let mut p = Parser { b: bytes, i: 0 };
        let v = p.value()?;
        p.ws();
        if p.i != p.b.len() {
            return Err(format!("trailing input at byte {}", p.i));
        }
        Ok(v)
    }
}

fn quote(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn str_field(out: &mut String, key: &str, value: &str, comma: bool) {
    quote(out, key);
    out.push(':');
    quote(out, value);
    if comma {
        out.push(',');
    }
}

pub fn num_field(out: &mut String, key: &str, value: i64, comma: bool) {
    quote(out, key);
    out.push(':');
    out.push_str(&value.to_string());
    if comma {
        out.push(',');
    }
}

pub fn bool_field(out: &mut String, key: &str, value: bool, comma: bool) {
    quote(out, key);
    out.push(':');
    out.push_str(if value { "true" } else { "false" });
    if comma {
        out.push(',');
    }
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        if self.i < self.b.len() && self.b[self.i] == c {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", c as char, self.i))
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.ws();
        match self.b.get(self.i) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.literal("true", Json::Bool(true)),
            Some(b'f') => self.literal("false", Json::Bool(false)),
            Some(b'n') => self.literal("null", Json::Null),
            Some(_) => self.number(),
            None => Err("unexpected end of input".into()),
        }
    }

    fn literal(&mut self, word: &str, v: Json) -> Result<Json, String> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("invalid literal at byte {}", self.i))
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        while matches!(self.b.get(self.i), Some(c) if c.is_ascii_digit()) {
            self.i += 1;
        }
        if start == self.i {
            return Err(format!("expected value at byte {}", start));
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?;
        s.parse::<i64>()
            .map(Json::Num)
            .map_err(|_| format!("invalid number '{}'", s))
    }

    fn string(&mut self) -> Result<String, String> {
        self.eat(b'"')?;
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i).ok_or("unterminated string")?;
            self.i += 1;
            match c {
                b'"' => return Ok(out),
                b'\\' => {
                    let e = *self.b.get(self.i).ok_or("unterminated escape")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = self.b.get(self.i..self.i + 4).ok_or("short \\u escape")?;
                            let s = std::str::from_utf8(hex).map_err(|e| e.to_string())?;
                            let cp = u32::from_str_radix(s, 16).map_err(|e| e.to_string())?;
                            self.i += 4;
                            out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                        }
                        other => return Err(format!("bad escape '{}'", other as char)),
                    }
                }
                _ => out.push(c as char),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.eat(b'[')?;
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.i)),
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.eat(b'{')?;
        let mut pairs = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(pairs));
        }
        loop {
            self.ws();
            let key = self.string()?;
            self.ws();
            self.eat(b':')?;
            let value = self.value()?;
            if pairs.iter().any(|(k, _)| k == &key) {
                return Err(format!("duplicate key \"{}\" at byte {}", key, self.i));
            }
            pairs.push((key, value));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(pairs));
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.i)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flat_object() {
        let j = Json::parse(r#"{"a":"x","b":12,"c":true,"d":null}"#).unwrap();
        assert_eq!(j.get("a").and_then(Json::as_str), Some("x"));
        assert_eq!(j.get("b").and_then(Json::as_u32), Some(12));
        assert_eq!(j.get("c").and_then(Json::as_bool), Some(true));
        assert!(matches!(j.get("d"), Some(Json::Null)));
    }

    #[test]
    fn parses_nested_and_escapes() {
        let j = Json::parse(r#"{"o":{"n":":2"},"s":"a\"b\\c"}"#).unwrap();
        assert_eq!(
            j.get("o").and_then(|o| o.get("n")).and_then(Json::as_str),
            Some(":2")
        );
        assert_eq!(j.get("s").and_then(Json::as_str), Some("a\"b\\c"));
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "{",
            "{\"a\":}",
            "{\"a\":1}}",
            "{\"a\" 1}",
            "nope",
            "{\"a\":01x}",
        ] {
            assert!(Json::parse(bad).is_err(), "should reject {:?}", bad);
        }
    }

    #[test]
    fn rejects_wrong_types() {
        let j = Json::parse(r#"{"n":"12"}"#).unwrap();
        assert_eq!(j.get("n").and_then(Json::as_u32), None);
    }

    #[test]
    fn emits_escaped_strings() {
        let mut s = String::new();
        str_field(&mut s, "k", "a\"b\nc", false);
        assert_eq!(s, r#""k":"a\"b\nc""#);
        assert_eq!(
            Json::parse(&format!("{{{}}}", s))
                .unwrap()
                .get("k")
                .and_then(Json::as_str),
            Some("a\"b\nc")
        );
    }

    #[test]
    fn negative_numbers_do_not_parse_as_u32() {
        let j = Json::parse(r#"{"v":-3}"#).unwrap();
        assert_eq!(j.get("v").and_then(Json::as_u32), None);
        assert_eq!(j.get("v").and_then(Json::as_i64), Some(-3));
    }
}
