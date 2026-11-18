import { unzipSync, zipSync } from 'fflate';

if (typeof window !== 'undefined') {
    window.__fflateUnzipSync = unzipSync;
    window.__fflateZipSync = zipSync;
}
