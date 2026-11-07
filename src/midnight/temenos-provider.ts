import { createVeriteeAttestedProver, type CreateAttestedProver, type VeriteeVerifier } from '@laceio/sdk/midnight';
import { AMD_ROOT_CERTIFICATES, AkxChannelBinder, AkxEvidenceProvider, AttestationVerificationError, AttestationVerifier, LocalCheckFailedError, RealLedgerClient, RealLocalVerifier, RealWardenClient } from '@input-output-hk/temenos-attestation-verifier';
import { createTemenosFetch } from './temenos-fetch';

const verifier: VeriteeVerifier = {
  LocalCheckFailedError, AttestationVerificationError,
  createVerifier: config => {
    const fetchImpl = createTemenosFetch();
    return new AttestationVerifier({
      evidenceProvider: AkxEvidenceProvider.fromConfig(config, { fetchImpl }),
      ledgerClient: RealLedgerClient.fromConfig(config, { fetchImpl }),
      localVerifier: new RealLocalVerifier(),
      wardenClient: RealWardenClient.fromConfig(config, { fetchImpl }),
      channelBinder: AkxChannelBinder.fromConfig(config, { fetchImpl }),
    }, config);
  },
};

// Shared by the real wallet runtime and wallet-free attestation preflight.
// SDK chooses the baked deployment; AMD roots come only from the pinned verifier.
export const createConsumerTemenosProver: CreateAttestedProver = props => createVeriteeAttestedProver({
  ...props, verifier, trustRoots: { amdRootCertificates: [...AMD_ROOT_CERTIFICATES] },
});
