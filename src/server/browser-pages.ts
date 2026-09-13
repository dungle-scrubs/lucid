import hub from "./client/hub.html";
import index from "./client/index.html";

// The portable build supplies prebuilt Responses and their asset routes here.
// Source and compiled-binary runs use Bun's embedded HTML bundles.
export const browserPages = { assets: {}, hub, index };
