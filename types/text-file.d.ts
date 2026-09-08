/**
 * Plain-text imports. Bun's bundler loads .txt as its contents, and this is
 * how the browser surface carries the frame's font subset (see
 * src/server/client/fonts/). One narrow wildcard rather than a loader
 * config: nothing else in the tree imports a text file.
 */
declare module "*.txt" {
  const contents: string;
  export default contents;
}
