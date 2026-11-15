import { expect, test } from "vitest";

import { googleClientId } from "../src/google-calendar/client";

const bundled = {
  clientId: "bundled.apps.googleusercontent.com",
  clientSecret: "desktop-app-config",
};

test("the packaged app is selected until a custom app is explicitly enabled", () => {
  const settings = {
    clientId: "custom.apps.googleusercontent.com",
    useCustomClient: false,
  };
  expect(googleClientId(settings, bundled)).toBe(bundled.clientId);
  expect(googleClientId({ ...settings, useCustomClient: true }, bundled)).toBe(
    settings.clientId,
  );
  expect(
    googleClientId({ clientId: "", useCustomClient: false }, bundled),
  ).toBe(bundled.clientId);
});

test("unconfigured source builds can retain an existing custom registration", () => {
  expect(
    googleClientId(
      {
        clientId: " custom.apps.googleusercontent.com ",
        useCustomClient: true,
      },
      null,
    ),
  ).toBe("custom.apps.googleusercontent.com");
  expect(googleClientId({ clientId: "", useCustomClient: false }, null)).toBe(
    "",
  );
});
