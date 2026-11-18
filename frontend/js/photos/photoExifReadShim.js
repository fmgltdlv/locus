import { gps, parse } from 'exifr/dist/lite.esm.mjs';

const EXIF_PARSE_PICK = [
    'Make',
    'Model',
    'DateTimeOriginal',
    'CreateDate',
    'ModifyDate',
    'DateTime',
    'Orientation',
    'ISO',
    'ISOSpeedRatings',
    'FNumber',
    'ExposureTime',
    'FocalLength',
    'LensModel',
];

if (typeof window !== 'undefined') {
    /**
     * Read GPS + common EXIF tags from the original file (including HEIC) before conversion.
     * @param {Blob|File} file
     * @returns {Promise<{ gps: {lat,lng}|null, exifData: object, exifRaw: object }>}
     */
    window.__readPhotoExifFromFile = async function (file) {
        const [gpsCoords, parsed] = await Promise.all([
            gps(file).catch(function () {
                return null;
            }),
            parse(file, { pick: EXIF_PARSE_PICK }).catch(function () {
                return {};
            }),
        ]);
        const tags = parsed && typeof parsed === 'object' ? parsed : {};
        let latlng = null;
        if (gpsCoords && Number.isFinite(gpsCoords.latitude) && Number.isFinite(gpsCoords.longitude)) {
            latlng = { lat: gpsCoords.latitude, lng: gpsCoords.longitude };
        }
        const dateTime = tags.DateTimeOriginal || tags.CreateDate || tags.ModifyDate || tags.DateTime || null;
        const exifData = {
            dateTime: dateTime != null ? String(dateTime) : null,
            make: tags.Make != null ? String(tags.Make) : null,
            model: tags.Model != null ? String(tags.Model) : null,
            orientation: tags.Orientation != null ? tags.Orientation : null,
            hasGPS: !!latlng,
            gpsLat: latlng ? latlng.lat : null,
            gpsLng: latlng ? latlng.lng : null,
            gpsSource: latlng ? 'EXIF' : 'None',
            iso: tags.ISO != null ? tags.ISO : tags.ISOSpeedRatings != null ? tags.ISOSpeedRatings : null,
            fNumber: tags.FNumber != null ? tags.FNumber : null,
            exposureTime: tags.ExposureTime != null ? tags.ExposureTime : null,
            focalLength: tags.FocalLength != null ? tags.FocalLength : null,
            lensModel: tags.LensModel != null ? String(tags.LensModel) : null,
        };
        const exifRaw = Object.assign({}, tags);
        if (gpsCoords) {
            if (gpsCoords.latitude != null) exifRaw.latitude = gpsCoords.latitude;
            if (gpsCoords.longitude != null) exifRaw.longitude = gpsCoords.longitude;
            if (gpsCoords.altitude != null) exifRaw.GPSAltitude = gpsCoords.altitude;
        }
        return { gps: latlng, exifData: exifData, exifRaw: exifRaw };
    };
}
