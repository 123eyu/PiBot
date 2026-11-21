import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Avatar,
  type AvatarColor,
  type AvatarEyes,
  type AvatarShape,
  type AvatarState,
  Button,
  Card,
  IconButton,
  Logo,
  type LogoTone,
  type LogoVariant,
  SegmentedControl,
  Switch,
  TextField,
  ThemeProvider,
  useTheme,
} from "../src/index.ts";

describe("Avatar", () => {
  it("matches the default Pi body and slanted eye geometry from the design", () => {
    const html = renderToStaticMarkup(<Avatar label="Pi" />);
    expect(html).toContain('aria-label="Pi"');
    expect(html).toContain(
      'd="M50 6 C80 6 94 20 94 50 C94 80 80 94 50 94 C20 94 6 80 6 50 C6 20 20 6 50 6 Z"',
    );
    expect(html).toContain('d="M35 35 L39 47 M65 35 L61 47 "');
    expect(html).toContain('fill="var(--avatar-violet)"');
    expect(html).toContain('stroke="var(--avatar-eye)"');
    expect(html).toContain("--blink-delay:0.0s");
  });

  it.each([
    "blob",
    "pill",
    "drop",
    "pebble",
    "flower",
    "cloud",
    "ghost",
    "cat",
    "hex",
    "circle",
    "bean",
    "tri",
  ] as const)("renders %s with its own geometry", (shape: AvatarShape) => {
    const html = renderToStaticMarkup(<Avatar shape={shape} />);
    expect(html).toContain('viewBox="0 0 100 100"');
    expect(html).not.toContain("undefined");
    expect(html.match(/<path/g)).toHaveLength(3);
    if (shape !== "blob") expect(html).not.toContain('d="M50 6 C80 6 94 20');
  });

  it.each([
    "orange",
    "amber",
    "blue",
    "violet",
    "pink",
    "teal",
    "green",
    "brown",
    "ink",
    "gray",
  ] as const)("uses the %s palette tokens", (color: AvatarColor) => {
    const html = renderToStaticMarkup(<Avatar color={color} />);
    expect(html).toContain(`fill="var(--avatar-${color})"`);
    expect(html).toContain(`stroke="var(--avatar-eye${color === "gray" ? "-gray" : ""})"`);
  });

  it.each(["marks", "dot", "oval", "pixel", "sleepy"] as const)(
    "renders %s eyes",
    (eyes: AvatarEyes) => {
      const html = renderToStaticMarkup(<Avatar eyes={eyes} />);
      const expected = {
        marks: "M35 35 L39 47",
        dot: "a5.5 5.5",
        oval: "a4.5 7",
        pixel: "h9 v9 h-9",
        sleepy: "M31 42 Q37 47 43 42",
      };
      expect(html).toContain(expected[eyes]);
    },
  );

  it.each(["idle", "thinking", "working", "waiting", "blocked", "done"] as const)(
    "renders the %s state",
    (state: AvatarState) => {
      const html = renderToStaticMarkup(<Avatar state={state} />);
      expect(html).toContain(`data-state="${state}"`);
      const expected = {
        idle: "M35 35 L39 47",
        thinking: "M35 30 L39 42",
        working: "M40 36 L44 48",
        waiting: "M35 37 L39 49",
        blocked: "M32 37 L42 47 M42 37 L32 47",
        done: "M31 45 Q37 35 43 45",
      };
      expect(html).toContain(expected[state]);
    },
  );

  it("state expressions override configured eyes and escape the accessible name", () => {
    expect(renderToStaticMarkup(<Avatar state="blocked" eyes="pixel" />)).not.toContain("h9 v9");
    expect(renderToStaticMarkup(<Avatar label="<Pi>" />)).toContain('aria-label="&lt;Pi&gt;"');
  });
});

describe("Logo", () => {
  it.each(["mark", "app-mac", "app-win", "app-linux", "tray"] as const)(
    "renders %s geometry and marks eyes",
    (variant: LogoVariant) => {
      const html = renderToStaticMarkup(<Logo variant={variant} />);
      expect(html).toContain(`data-variant="${variant}"`);
      expect(html).toContain('d="M38 41 L40 57"');
      expect(html).toContain('d="M62 41 L60 57"');
      if (variant === "tray") {
        expect(html.match(/<path/g)).toHaveLength(3);
        expect(html).toContain('fill="var(--tray-ink)"');
        expect(html).toContain('mask="url(#');
        expect(html).toContain('stroke="var(--logo-mask-cutout)"');
      } else {
        expect(html.match(/<path/g)).toHaveLength(3);
        expect(html).toContain(
          variant === "app-mac"
            ? "M0 0 H100 V100 H0 Z"
            : variant === "app-linux"
              ? "M50 3 A47 47"
              : variant === "app-win"
                ? "M50 6 C80 6"
                : "M22 0 H78",
        );
      }
    },
  );

  it.each(["violet", "ink", "paper", "night"] as const)(
    "supports the %s tone",
    (tone: LogoTone) => {
      expect(renderToStaticMarkup(<Logo tone={tone} />)).toContain(
        `stroke="var(--logo-${tone}-ink)"`,
      );
      expect(renderToStaticMarkup(<Logo tone={tone} variant="tray" />)).toContain(
        `fill="var(--tray-${tone === "paper" ? "paper" : "ink"})"`,
      );
    },
  );

  it("adjusts strokes for small icons", () => {
    expect(renderToStaticMarkup(<Logo variant="tray" size={16} />)).toContain(
      'stroke-width="10.5"',
    );
    expect(renderToStaticMarkup(<Logo size={16} />)).toContain('stroke-width="10.5"');
    expect(renderToStaticMarkup(<Logo variant="app-mac" size={16} />)).toContain(
      'stroke-width="10.5"',
    );
  });
});

describe("base components", () => {
  it("uses safe button defaults and disables loading buttons", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain('type="button"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Save");
    expect(
      renderToStaticMarkup(
        <Button type="submit" variant="ghost">
          Send
        </Button>,
      ),
    ).toContain('type="submit"');
  });

  it("names icon buttons and hides decorative contents", () => {
    const html = renderToStaticMarkup(
      <IconButton label="Send">
        <svg>
          <title>Arrow</title>
        </svg>
      </IconButton>,
    );
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("links input label, help, and error text without dropping caller descriptions", () => {
    const html = renderToStaticMarkup(
      <TextField
        id="key"
        label="API key"
        type="password"
        description="Never shown again"
        error="Invalid key"
        aria-describedby="extra"
      />,
    );
    expect(html).toContain('for="key"');
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="extra key-description key-error"');
    expect(html).toContain('id="key-error"');
    expect(html).toContain('role="alert"');
  });

  it("exposes switch state and native radio group semantics", () => {
    const switchHtml = renderToStaticMarkup(
      <Switch label="Open at login" checked onCheckedChange={() => {}} />,
    );
    expect(switchHtml).toContain('role="switch"');
    expect(switchHtml).toContain('aria-checked="true"');
    expect(switchHtml).toContain('aria-label="Open at login"');
    const radios = renderToStaticMarkup(
      <SegmentedControl
        label="Theme"
        value="light"
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark", disabled: true },
        ]}
        onValueChange={() => {}}
      />,
    );
    expect(radios).toContain("<legend");
    expect(radios).toContain("Theme</legend>");
    expect(radios.match(/type="radio"/g)).toHaveLength(2);
    expect(radios.match(/checked=""/g)).toHaveLength(1);
    expect(radios.match(/<input[^>]*value="dark"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it("allows card content and host attributes", () => {
    const html = renderToStaticMarkup(
      <Card aria-label="Settings" className="custom">
        Hello
      </Card>,
    );
    expect(html).toContain("custom");
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain("Hello</div>");
  });

  it("renders theme context on the server without browser globals", () => {
    function Probe() {
      return <span>{useTheme().resolvedTheme}</span>;
    }
    expect(
      renderToStaticMarkup(
        <ThemeProvider theme="dark">
          <Probe />
        </ThemeProvider>,
      ),
    ).toBe("<span>dark</span>");
    expect(
      renderToStaticMarkup(
        <ThemeProvider>
          <Probe />
        </ThemeProvider>,
      ),
    ).toBe("<span>light</span>");
  });
});
