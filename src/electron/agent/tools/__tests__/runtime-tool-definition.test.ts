import { describe, expect, it } from "vitest";
import {
  getDefaultRuntimeToolMetadata,
  withRuntimeToolMetadata,
} from "../runtime-tool-definition";

describe("runtime tool definition metadata", () => {
  it("marks core read tools as parallel-safe and read-only", () => {
    const metadata = getDefaultRuntimeToolMetadata("read_file");
    expect(metadata.readOnly).toBe(true);
    expect(metadata.concurrencyClass).toBe("read_parallel");
    expect(metadata.interruptBehavior).toBe("cancel");
    expect(metadata.resultKind).toBe("read");
  });

  it("marks command execution as blocking and non-read-only", () => {
    const metadata = getDefaultRuntimeToolMetadata("run_command");
    expect(metadata.readOnly).toBe(false);
    expect(metadata.concurrencyClass).toBe("exclusive");
    expect(metadata.interruptBehavior).toBe("cancel");
    expect(metadata.approvalKind).toBe("shell_sensitive");
  });

  it("preserves explicit metadata overrides", () => {
    const tool = withRuntimeToolMetadata(
      {
        name: "custom_tool",
        description: "Custom tool",
        input_schema: {
          type: "object",
          properties: {},
        },
      },
      {
        deferLoad: true,
        alwaysExpose: false,
      },
    );
    expect(tool.runtime?.deferLoad).toBe(true);
    expect(tool.runtime?.alwaysExpose).toBe(false);
  });

  it("marks session checklist tools with the expected approval and concurrency metadata", () => {
    const createMetadata = getDefaultRuntimeToolMetadata("task_list_create");
    const listMetadata = getDefaultRuntimeToolMetadata("task_list_list");

    expect(createMetadata.concurrencyClass).toBe("serial_only");
    expect(createMetadata.readOnly).toBe(false);
    expect(createMetadata.approvalKind).toBe("none");

    expect(listMetadata.concurrencyClass).toBe("read_parallel");
    expect(listMetadata.readOnly).toBe(true);
    expect(listMetadata.approvalKind).toBe("none");
  });
});
