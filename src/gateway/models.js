import { getAvailableModels } from "../providers/index.js";

/**
 * Handle GET /v1/models
 */
export function handleListModels(c) {
  const models = getAvailableModels();
  return c.json({
    object: "list",
    data: models,
  });
}
