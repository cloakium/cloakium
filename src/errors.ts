/** Typed errors raised by the wrapper. All extend `Error` for drop-in use. */

export class CloakiumError extends Error {
  constructor(message: string, init?: { cause?: unknown }) {
    super(message, init);
    this.name = new.target.name;
  }
}

export class BinaryNotFoundError extends CloakiumError {}

export class ProxyAuthUnsupportedError extends CloakiumError {}

export class GeoipUnavailableError extends CloakiumError {}

export class GeoipLookupError extends CloakiumError {}

export class HumanizeError extends CloakiumError {}

export class HumanizeTimeoutError extends HumanizeError {
  constructor(message: string) {
    super(message);
    this.name = "HumanizeTimeoutError";
  }
}

export class HumanizeCoveredError extends HumanizeError {}

export class ConfigurationError extends CloakiumError {}
