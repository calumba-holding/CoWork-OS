import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFeaturesSettings } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  let storedSettings: Partial<MemoryFeaturesSettings> | undefined;

  return {
    get storedSettings() {
      return storedSettings;
    },
    set storedSettings(value: Partial<MemoryFeaturesSettings> | undefined) {
      storedSettings = value;
    },
    repositorySave: vi.fn().mockImplementation((_key: string, settings: unknown) => {
      storedSettings = settings as Partial<MemoryFeaturesSettings>;
    }),
    repositoryLoad: vi.fn().mockImplementation(() => storedSettings),
  };
});

vi.mock("../../database/SecureSettingsRepository", () => ({
  SecureSettingsRepository: {
    isInitialized: vi.fn().mockReturnValue(true),
    getInstance: vi.fn().mockReturnValue({
      save: mocks.repositorySave,
      load: mocks.repositoryLoad,
    }),
  },
}));

import { MemoryFeaturesManager } from "../memory-features-manager";

describe("MemoryFeaturesManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storedSettings = undefined;
    MemoryFeaturesManager.clearCache();
    MemoryFeaturesManager.initialize();
  });

  it("defaults the experimental memory stack off", () => {
    const settings = MemoryFeaturesManager.loadSettings();

    expect(settings.contextPackInjectionEnabled).toBe(true);
    expect(settings.heartbeatMaintenanceEnabled).toBe(true);
    expect(settings.promptStackV2Enabled).toBe(false);
    expect(settings.layeredMemoryEnabled).toBe(false);
    expect(settings.transcriptStoreEnabled).toBe(false);
    expect(settings.backgroundConsolidationEnabled).toBe(false);
    expect(settings.queryOrchestratorEnabled).toBe(false);
    expect(settings.sessionLineageEnabled).toBe(false);
  });

  it("preserves explicit experimental settings when loaded", () => {
    mocks.storedSettings = {
      contextPackInjectionEnabled: false,
      heartbeatMaintenanceEnabled: true,
      promptStackV2Enabled: true,
      layeredMemoryEnabled: true,
      transcriptStoreEnabled: true,
      backgroundConsolidationEnabled: true,
      queryOrchestratorEnabled: true,
      sessionLineageEnabled: true,
    };

    MemoryFeaturesManager.clearCache();
    const settings = MemoryFeaturesManager.loadSettings();

    expect(settings.contextPackInjectionEnabled).toBe(false);
    expect(settings.heartbeatMaintenanceEnabled).toBe(true);
    expect(settings.promptStackV2Enabled).toBe(true);
    expect(settings.layeredMemoryEnabled).toBe(true);
    expect(settings.transcriptStoreEnabled).toBe(true);
    expect(settings.backgroundConsolidationEnabled).toBe(true);
    expect(settings.queryOrchestratorEnabled).toBe(true);
    expect(settings.sessionLineageEnabled).toBe(true);
  });

  it("saves partial settings with experimental features disabled by default", () => {
    const settings: MemoryFeaturesSettings = {
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
    };

    MemoryFeaturesManager.saveSettings(settings);

    expect(mocks.storedSettings).toEqual({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      promptStackV2Enabled: false,
      layeredMemoryEnabled: false,
      transcriptStoreEnabled: false,
      backgroundConsolidationEnabled: false,
      queryOrchestratorEnabled: false,
      sessionLineageEnabled: false,
    });
  });
});
