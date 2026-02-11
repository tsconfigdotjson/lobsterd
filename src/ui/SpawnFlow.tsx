import { PasswordInput, Select, Spinner, StatusMessage } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { type SpawnProgress, runSpawn } from "../commands/spawn.js";
import { MODEL_CATALOG, buildProviderConfig } from "../config/models.js";
import type { Tenant } from "../types/index.js";
import { LOBSTER } from "./theme.js";

type Step = "select-model" | "enter-api-key" | "spawning" | "done";

interface Props {
  name: string;
}

const selectOptions = MODEL_CATALOG.map((entry) => ({
  label: entry.label,
  value: entry.id,
}));

export function SpawnFlow({ name }: Props) {
  const { exit } = useApp();

  const [step, setStep] = useState<Step>("select-model");
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [progress, setProgress] = useState<SpawnProgress | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleModelSelect(value: string) {
    setSelectedModelId(value);
    setStep("enter-api-key");
  }

  function handleApiKeySubmit(apiKey: string) {
    if (!apiKey.trim()) return;

    const entry = MODEL_CATALOG.find((e) => e.id === selectedModelId);
    if (!entry) return;

    const override = buildProviderConfig(entry, apiKey.trim());
    setStep("spawning");

    runSpawn(name, (p) => setProgress(p), { openclawOverride: override }).then(
      (result) => {
        if (result.isOk()) {
          setTenant(result.value);
        } else {
          setError(result.error.message);
        }
        setStep("done");
      },
    );
  }

  useEffect(() => {
    if (step === "done") {
      exit();
    }
  }, [step, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        {LOBSTER} lobsterd spawn {name}
      </Text>

      {step === "select-model" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Select a model provider:</Text>
          <Select options={selectOptions} onChange={handleModelSelect} />
        </Box>
      )}

      {step === "enter-api-key" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>API key:</Text>
            <PasswordInput
              placeholder="Enter your API key"
              onSubmit={handleApiKeySubmit}
            />
          </Box>
        </Box>
      )}

      {step === "spawning" && (
        <Box flexDirection="column" marginTop={1}>
          <Spinner
            label={
              progress
                ? `[${progress.step}] ${progress.detail}`
                : "Starting..."
            }
          />
        </Box>
      )}

      {step === "done" && error && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}

      {step === "done" && tenant && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="success">
            Tenant "{tenant.name}" spawned successfully
          </StatusMessage>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            <Text>
              CID: <Text bold>{tenant.cid}</Text>
            </Text>
            <Text>
              IP: <Text bold>{tenant.ipAddress}</Text>
            </Text>
            <Text>
              Port: <Text bold>{tenant.gatewayPort}</Text>
            </Text>
            <Text>
              PID: <Text bold>{tenant.vmPid}</Text>
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
