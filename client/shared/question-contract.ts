/**
 * The question-contract re-export surface for the chrome (M4.5): the drawer and
 * its helpers reach the question-contract vocabulary through THIS door rather
 * than importing `src/core/question-contract.ts` directly, so a client
 * component never depends on a server-tier module. The contract itself stays in
 * core (the server's question validation is the same code).
 */
export * from "../../src/core/question-contract.ts";
