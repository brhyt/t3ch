import * as CloudLink from "../cloud/CloudLink.ts";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Settings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as Controls from "./PrivacyControls.ts";

it.effect(
  "changes only requested provider controls, preserves credentials, and reports configuration without claiming capture",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const controls = yield* Controls.PrivacyControls;
      const id = ProviderInstanceId.make("private-claude");
      expect(yield* controls.activity()).toBe(true);
      const initial = yield* controls.snapshot();
      expect(initial.serverTelemetry).toBe("off");
      expect(initial.providers.find((p) => p.id === id)).toMatchObject({
        inheritedEnvironment: "unrestricted",
        telemetry: "unknown",
        proxyConfigured: true,
      });
      yield* controls.changeProvider({ action: "inheritance", instanceId: id, restricted: true });
      const current = yield* settings.getSettings;
      expect(current.providerInstances[id]?.environment).toContainEqual({
        name: "ANTHROPIC_API_KEY",
        value: "fixture-only",
        sensitive: true,
      });
      const snapshot = yield* controls.snapshot();
      expect(JSON.stringify(snapshot)).not.toContain("fixture-only");
      expect(snapshot.providers.find((p) => p.id === id)).toMatchObject({
        inheritedEnvironment: "restricted",
        telemetry: "off",
        proxyConfigured: true,
      });
      yield* controls.changeProvider({ action: "claude-telemetry", instanceId: id, enabled: true });
      expect((yield* controls.snapshot()).providers.find((p) => p.id === id)?.telemetry).toBe(
        "unknown",
      );
      yield* controls.changeProvider({ action: "inheritance", instanceId: id, restricted: false });
      expect(
        (yield* controls.snapshot()).providers.find((p) => p.id === id)?.instanceAllowlist,
      ).toBeNull();
      expect(
        (yield* controls
          .changeProvider({
            action: "claude-telemetry",
            instanceId: ProviderInstanceId.make("missing"),
            enabled: true,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("invalid_control");
    }).pipe(
      Effect.provide(
        Controls.layer.pipe(
          Layer.provideMerge(
            Settings.ServerSettingsService.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("private-claude")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  environment: [
                    { name: "ANTHROPIC_API_KEY", value: "fixture-only", sensitive: true },
                  ],
                },
              },
            }),
          ),
          Layer.provide(
            ServerConfig.ServerConfig.layerTest("/tmp", { prefix: "privacy-controls-test-" }),
          ),
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.mock(CloudLink.CloudLink)({
              linkState: () =>
                Effect.succeed({
                  linked: true,
                  cloudUserId: null,
                  relayUrl: null,
                  relayIssuer: null,
                  publishAgentActivity: true,
                }),
            }),
          ),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
        HTTPS_PROXY: "http://127.0.0.1:8899",
      }),
    ),
);
