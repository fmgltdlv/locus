/**
 * Peek upload zips and split contents into images, PDFs, and map files.
 * Uses window.__fflateUnzipSync / __fflateZipSync (fflateZipShim).
 */
(function (global) {
    var IMAGE_EXT = /\.(jpe?g|png|heic|heif)$/i;
    var PDF_EXT = /\.pdf$/i;
    var KML_EXT = /\.kml$/i;
    var KMZ_EXT = /\.kmz$/i;
    var GEOJSON_EXT = /\.(geojson|json)$/i;
    var ZIP_EXT = /\.zip$/i;
    var SHP_SIDECAR_EXT = /\.(shp|shx|dbf|prj|cpg|sbn|sbx|qix|aih|ain|ixs|mxs|atx|cst)$/i;
    var MOBILE_IMAGE_CAP = 25;

    function isZipUploadFile(file) {
        if (!file) return false;
        var name = file.name || '';
        if (KMZ_EXT.test(name)) return false;
        var type = String(file.type || '').toLowerCase();
        return ZIP_EXT.test(name) || type === 'application/zip' || type === 'application/x-zip-compressed';
    }

    function isMobilePick() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
            (typeof navigator !== 'undefined' && navigator.userAgent) || ''
        ) || (typeof window !== 'undefined' && window.innerWidth <= 768);
    }

    function skipZipPath(path) {
        if (!path || path.endsWith('/')) return true;
        if (path.indexOf('__MACOSX/') === 0 || path.indexOf('/__MACOSX/') !== -1) return true;
        var base = path.split('/').pop() || path;
        return !base || base.charAt(0) === '.';
    }

    function baseName(path) {
        return path.split('/').pop() || path;
    }

    function mimeForName(name) {
        var n = String(name || '').toLowerCase();
        if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
        if (n.endsWith('.png')) return 'image/png';
        if (n.endsWith('.heic') || n.endsWith('.heif')) return 'image/heic';
        if (n.endsWith('.pdf')) return 'application/pdf';
        if (n.endsWith('.kml')) return 'application/vnd.google-earth.kml+xml';
        if (n.endsWith('.kmz')) return 'application/vnd.google-earth.kmz';
        return 'application/octet-stream';
    }

    function fileFromBytes(name, data) {
        return new File([data], name, { type: mimeForName(name) });
    }

    function emptyResult() {
        return {
            images: [],
            documents: [],
            geoFiles: [],
            passthrough: [],
            errors: [],
            imagesOmitted: 0,
        };
    }

    async function expandOneZip(zipFile, acc, mobileCap) {
        var unzipSync = global.__fflateUnzipSync;
        var zipSync = global.__fflateZipSync;
        if (typeof unzipSync !== 'function') {
            acc.errors.push('Could not read ' + (zipFile.name || 'zip') + '.');
            return;
        }
        var entries;
        try {
            var bytes = new Uint8Array(await zipFile.arrayBuffer());
            var imageKept = acc.images.length;
            entries = unzipSync(bytes, {
                filter: function (file) {
                    var path = file && file.name ? file.name : '';
                    if (skipZipPath(path)) return false;
                    var name = baseName(path);
                    if (IMAGE_EXT.test(name)) {
                        if (mobileCap >= 0 && imageKept >= mobileCap) {
                            acc.imagesOmitted += 1;
                            return false;
                        }
                        imageKept += 1;
                        return true;
                    }
                    return (
                        PDF_EXT.test(name) ||
                        KML_EXT.test(name) ||
                        KMZ_EXT.test(name) ||
                        GEOJSON_EXT.test(name) ||
                        SHP_SIDECAR_EXT.test(name)
                    );
                },
            });
        } catch (_err) {
            acc.errors.push('Could not read ' + (zipFile.name || 'zip') + '.');
            return;
        }
        var shpParts = {};
        var hadUsable = false;
        var names = Object.keys(entries);
        for (var i = 0; i < names.length; i++) {
            var path = names[i];
            if (skipZipPath(path)) continue;
            var data = entries[path];
            if (!data || !data.length) continue;
            var name = baseName(path);
            if (IMAGE_EXT.test(name)) {
                acc.images.push(fileFromBytes(name, data));
                hadUsable = true;
            } else if (PDF_EXT.test(name)) {
                acc.documents.push(fileFromBytes(name, data));
                hadUsable = true;
            } else if (KML_EXT.test(name) || KMZ_EXT.test(name) || GEOJSON_EXT.test(name)) {
                acc.geoFiles.push(fileFromBytes(name, data));
                hadUsable = true;
            } else if (SHP_SIDECAR_EXT.test(name)) {
                shpParts[path] = data;
                hadUsable = true;
            }
        }
        if (Object.keys(shpParts).length) {
            if (typeof zipSync !== 'function') {
                acc.errors.push('Could not import shapefile from ' + (zipFile.name || 'zip') + '.');
            } else {
                var rebuilt = zipSync(shpParts);
                var outName = String(zipFile.name || 'shapefile.zip').replace(/\.zip$/i, '') + '-shapefile.zip';
                acc.geoFiles.push(new File([rebuilt], outName, { type: 'application/zip' }));
            }
        }
        if (!hadUsable) {
            acc.errors.push('No images, PDFs, or map files found in ' + (zipFile.name || 'zip') + '.');
        }
    }

    async function expandUploadFiles(files) {
        var list = Array.prototype.slice.call(files || []);
        var acc = emptyResult();
        var mobileCap = isMobilePick() ? MOBILE_IMAGE_CAP : -1;
        for (var i = 0; i < list.length; i++) {
            var file = list[i];
            if (isZipUploadFile(file)) {
                await expandOneZip(file, acc, mobileCap);
            } else {
                acc.passthrough.push(file);
            }
        }
        return acc;
    }

    global.expandUploadFiles = expandUploadFiles;
    global.isZipUploadFile = isZipUploadFile;
})(typeof window !== 'undefined' ? window : globalThis);
