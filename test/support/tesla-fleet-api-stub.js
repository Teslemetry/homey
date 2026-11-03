// Test-only ESM redirect target for "tesla-fleet-api" (see loader.mjs).
// Teslemetry's energy sites are the cloud site a test hands to fakeCloud, so
// enrolment never reaches the network. The enums and error classes are the
// real library's, so the app's state comparisons and instanceof checks see
// the values the library would produce.
export {
  AuthorizedClientKeyType,
  AuthorizedClientState,
  AuthorizedClientType,
  EnergyGatewayUnreachable,
} from "../../node_modules/tesla-fleet-api/dist/index.mjs";

export const fakeCloud = {
  /** The cloud site the next `energySites.create()` returns. */
  site: null,
  /** Each site id `energySites.create()` was called with. */
  created: [],
};

export class Teslemetry {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.energySites = {
      create: (siteId) => {
        fakeCloud.created.push(siteId);
        return fakeCloud.site;
      },
    };
  }
}
