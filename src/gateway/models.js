import { getAvailableModels } from "../providers/index.js";

/**
 * Handle GET /v1/models
 */
export function handleListModels(c) {
  const all = c.req.query("all") === "true" || c.req.query("showAll") === "true";
  const models = getAvailableModels({ all });
  return c.json({
    object: "list",
    data: models,
  });
}
