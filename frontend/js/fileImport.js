// File Import module - File upload, parsing, and coordinate transformation

// Store for current file being imported (to get filename for layer name)
let currentImportFile = null;

// Initialize data upload (GeoJSON, KML, etc.)
function initDataUpload() {
    // Cancel any active drawing or measuring
    const drawingModule = window.drawingModule;
    if (drawingModule && drawingModule.currentDrawingMode) {
        drawingModule.cancelDrawingMode();
    }
    if (window.cancelMeasureMode) {
        window.cancelMeasureMode();
    }
    if (window.photoUploadMode && window.cancelPhotoUpload) {
        window.cancelPhotoUpload();
    }
    
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.geojson,.json,.kml,.kmz,.zip,.shp';
    input.multiple = false;
    
    input.onchange = function(event) {
        const file = event.target.files[0];
        if (file) {
            // Check file size (1 MB limit)
            const maxSize = 1 * 1024 * 1024; // 1 MB in bytes
            if (file.size > maxSize) {
                const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
                appAlert(`File size (${fileSizeMB} MB) exceeds the 1 MB limit. Please use a smaller file.`);
                return;
            }
            
            parseDataFile(file);
        }
    };
    
    input.click();
}

// Parse uploaded data file
function parseDataFile(file) {
    currentImportFile = file; // Store file reference for layer naming
    const fileName = file.name.toLowerCase();
    
    // Handle different file types
    if (fileName.endsWith('.geojson') || fileName.endsWith('.json')) {
        parseGeoJSONFile(file);
    } else if (fileName.endsWith('.kml')) {
        parseKMLFile(file);
    } else if (fileName.endsWith('.kmz')) {
        parseKMZFile(file);
    } else if (fileName.endsWith('.zip') || fileName.endsWith('.shp')) {
        // Could be a shapefile (ZIP) or zipped shapefile
        parseShapefile(file);
    } else {
        appAlert('Unsupported file format. Please use GeoJSON, JSON, KML, KMZ, or Shapefile (ZIP).');
    }
}

// Parse GeoJSON file
function parseGeoJSONFile(file) {
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            const text = e.target.result;
            if (!text || text.trim() === '') {
                appAlert('File is empty or could not be read.');
                return;
            }
            
            const geojson = JSON.parse(text);
            if (!geojson) {
                appAlert('Invalid GeoJSON file. The file appears to be empty or malformed.');
                return;
            }
            
            processImportedGeoJSON(geojson);
        } catch (error) {
            console.error('Error parsing GeoJSON:', error);
            appAlert('Error parsing GeoJSON file: ' + error.message + '\n\nPlease ensure the file is valid GeoJSON format.');
        }
    };
    
    reader.onerror = function(error) {
        console.error('FileReader error:', error);
        appAlert('Error reading file. Please try again.');
    };
    
    reader.onabort = function() {
        appAlert('File reading was cancelled.');
    };
    
    reader.readAsText(file);
}

// Parse KML file
function parseKMLFile(file) {
    const reader = new FileReader();
    
    reader.onload = function(e) {
        try {
            // Check if toGeoJSON is available
            if (typeof toGeoJSON === 'undefined') {
                appAlert('KML parsing library not loaded. Please refresh the page.');
                return;
            }
            
            const kmlText = e.target.result;
            const kml = new DOMParser().parseFromString(kmlText, 'text/xml');
            
            // Convert KML to GeoJSON
            const geojson = toGeoJSON.kml(kml);
            
            if (!geojson || !geojson.type) {
                appAlert('Invalid KML file or no features found.');
                return;
            }
            
            processImportedGeoJSON(geojson);
        } catch (error) {
            console.error('Error parsing KML:', error);
            appAlert('Error parsing KML file: ' + error.message);
        }
    };
    
    reader.onerror = function() {
        appAlert('Error reading file. Please try again.');
    };
    
    reader.readAsText(file);
}

// Parse KMZ file (zipped KML)
function parseKMZFile(file) {
    // Check if JSZip is available
    if (typeof JSZip === 'undefined') {
        appAlert('KMZ parsing library not loaded. Please refresh the page.');
        return;
    }
    
    JSZip.loadAsync(file)
        .then(function(zip) {
            // Find the KML file in the ZIP (usually doc.kml or the first .kml file)
            const kmlFiles = Object.keys(zip.files).filter(name => name.toLowerCase().endsWith('.kml'));
            
            if (kmlFiles.length === 0) {
                appAlert('No KML file found in KMZ archive.');
                return;
            }
            
            // Use the first KML file found
            return zip.files[kmlFiles[0]].async('string');
        })
        .then(function(kmlText) {
            try {
                // Check if toGeoJSON is available
                if (typeof toGeoJSON === 'undefined') {
                    appAlert('KML parsing library not loaded. Please refresh the page.');
                    return;
                }
                
                const kml = new DOMParser().parseFromString(kmlText, 'text/xml');
                const geojson = toGeoJSON.kml(kml);
                
                if (!geojson || !geojson.type) {
                    appAlert('Invalid KML file or no features found.');
                    return;
                }
                
                processImportedGeoJSON(geojson);
            } catch (error) {
                console.error('Error parsing KML from KMZ:', error);
                appAlert('Error parsing KML from KMZ: ' + error.message);
            }
        })
        .catch(function(error) {
            console.error('Error reading KMZ file:', error);
            appAlert('Error reading KMZ file: ' + error.message);
        });
}

// Parse shapefile (ZIP containing .shp, .shx, .dbf, etc.)
function parseShapefile(file) {
    // Check if shpjs is available
    if (typeof shp === 'undefined') {
        appAlert('Shapefile parsing library not loaded. Please refresh the page.');
        return;
    }
    
    // Check if JSZip is available (needed for .prj extraction)
    if (typeof JSZip === 'undefined') {
        appAlert('ZIP parsing library not loaded. Please refresh the page.');
        return;
    }
    
    // First, extract .prj file to determine coordinate system
    JSZip.loadAsync(file)
        .then(function(zip) {
            // Find .prj file
            const prjFiles = Object.keys(zip.files).filter(name => name.toLowerCase().endsWith('.prj'));
            let sourceCRS = null;
            
            if (prjFiles.length > 0) {
                // Read .prj file
                return zip.files[prjFiles[0]].async('string')
                    .then(function(prjText) {
                        sourceCRS = parsePrjFile(prjText);
                        return sourceCRS;
                    });
            }
            return null;
        })
        .then(function(sourceCRS) {
            // Now parse the shapefile
            return shp(file).then(function(geojson) {
                return { geojson: geojson, sourceCRS: sourceCRS };
            });
        })
        .then(async function(result) {
            let geojson = result.geojson;
            const sourceCRS = result.sourceCRS;
            
            if (!geojson || !geojson.type) {
                appAlert('Invalid shapefile or no features found.');
                return;
            }
            
            // Transform coordinates if needed
            if (sourceCRS && sourceCRS !== 'EPSG:4326') {
                try {
                    geojson = transformGeoJSONCoordinates(geojson, sourceCRS, 'EPSG:4326');
                } catch (error) {
                    const proceed = await appConfirm(
                        'Could not transform coordinates from ' + sourceCRS + '.\n\n' +
                        'The file may not display correctly. Continue anyway?'
                    );
                    if (!proceed) {
                        return;
                    }
                }
            }
            
            // Process the transformed GeoJSON
            processImportedGeoJSON(geojson);
        })
        .catch(function(error) {
            console.error('Error parsing shapefile:', error);
            appAlert('Error parsing shapefile: ' + (error.message || 'Invalid shapefile format. Make sure the ZIP contains .shp, .shx, and .dbf files.'));
        });
}

// Parse .prj file (WKT format) and convert to proj4 format
function parsePrjFile(prjText) {
    if (!prjText || typeof prjText !== 'string') {
        return null;
    }
    
    // Check if proj4js is available
    if (typeof proj4 === 'undefined') return null;
    
    try {
        // Try to parse as WKT and get EPSG code or proj4 string
        const trimmed = prjText.trim();
        
        // Check for common EPSG codes in WKT
        const epsgMatch = trimmed.match(/AUTHORITY\["EPSG","(\d+)"\]/i);
        if (epsgMatch) {
            const epsgCode = 'EPSG:' + epsgMatch[1];
            // Verify it's a known projection
            try {
                proj4.defs(epsgCode); // This will load from epsg.io if not already defined
                return epsgCode;
            } catch (e) {
                // Try to define it from WKT
                try {
                    const proj4String = wktToProj4(trimmed);
                    if (proj4String) {
                        proj4.defs(epsgCode, proj4String);
                        return epsgCode;
                    }
                } catch (e2) {
                    // Projection parse failed
                }
            }
        }
        
        // Try to convert WKT directly to proj4
        const proj4String = wktToProj4(trimmed);
        if (proj4String) {
            // Define a custom projection
            const customName = 'CUSTOM_' + Date.now();
            proj4.defs(customName, proj4String);
            return customName;
        }
        
        return null;
    } catch (error) {
        console.error('Error parsing .prj file:', error);
        return null;
    }
}

// Convert WKT to proj4 string (simplified - handles common cases)
function wktToProj4(wkt) {
    if (!wkt || typeof wkt !== 'string') {
        return null;
    }
    
    const upperWkt = wkt.toUpperCase();
    
    // Handle common projections
    if (upperWkt.includes('WGS_1984') || upperWkt.includes('WGS84')) {
        if (upperWkt.includes('GEOGRAPHIC') || upperWkt.includes('LATITUDE')) {
            return '+proj=longlat +datum=WGS84 +no_defs';
        }
    }
    
    if (upperWkt.includes('WEB_MERCATOR') || upperWkt.includes('MERCATOR_AUXILIARY')) {
        return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs';
    }
    
    // Extract projection name
    const projMatch = upperWkt.match(/PROJECTION\["([^"]+)"\]/);
    if (projMatch) {
        const projName = projMatch[1];
        
        // Extract parameters
        const paramMatches = wkt.match(/PARAMETER\["([^"]+)",([^\]]+)\]/g) || [];
        const params = {};
        paramMatches.forEach(match => {
            const paramMatch = match.match(/PARAMETER\["([^"]+)",([^\]]+)\]/);
            if (paramMatch) {
                params[paramMatch[1].toUpperCase()] = parseFloat(paramMatch[2]);
            }
        });
        
        // Extract datum
        const datumMatch = upperWkt.match(/DATUM\["([^"]+)"\]/);
        const datum = datumMatch ? datumMatch[1] : 'WGS84';
        
        // Build proj4 string based on projection type
        let proj4String = '';
        
        if (projName === 'TRANSVERSE_MERCATOR' || projName === 'TM') {
            proj4String = `+proj=tmerc +lat_0=${params['LATITUDE_OF_ORIGIN'] || 0} +lon_0=${params['CENTRAL_MERIDIAN'] || 0} +k=${params['SCALE_FACTOR'] || 1} +x_0=${params['FALSE_EASTING'] || 0} +y_0=${params['FALSE_NORTHING'] || 0}`;
        } else if (projName === 'LAMBERT_CONFORMAL_CONIC' || projName === 'LCC') {
            proj4String = `+proj=lcc +lat_1=${params['STANDARD_PARALLEL_1'] || 0} +lat_2=${params['STANDARD_PARALLEL_2'] || 0} +lat_0=${params['LATITUDE_OF_ORIGIN'] || 0} +lon_0=${params['CENTRAL_MERIDIAN'] || 0} +x_0=${params['FALSE_EASTING'] || 0} +y_0=${params['FALSE_NORTHING'] || 0}`;
        } else if (projName === 'ALBERS') {
            proj4String = `+proj=aea +lat_1=${params['STANDARD_PARALLEL_1'] || 0} +lat_2=${params['STANDARD_PARALLEL_2'] || 0} +lat_0=${params['LATITUDE_OF_ORIGIN'] || 0} +lon_0=${params['CENTRAL_MERIDIAN'] || 0} +x_0=${params['FALSE_EASTING'] || 0} +y_0=${params['FALSE_NORTHING'] || 0}`;
        } else if (projName === 'UNIVERSAL_TRANSVERSE_MERCATOR' || projName === 'UTM') {
            const zone = params['ZONE'] || Math.floor((params['CENTRAL_MERIDIAN'] || 0) / 6) + 31;
            const hemisphere = (params['LATITUDE_OF_ORIGIN'] || 0) >= 0 ? 'north' : 'south';
            proj4String = `+proj=utm +zone=${zone} +${hemisphere} +datum=WGS84`;
        }
        
        // Add datum
        if (datum.includes('WGS') || datum.includes('1984')) {
            proj4String += ' +datum=WGS84';
        } else if (datum.includes('NAD83')) {
            proj4String += ' +datum=NAD83';
        } else if (datum.includes('NAD27')) {
            proj4String += ' +datum=NAD27';
        } else {
            proj4String += ' +datum=WGS84'; // Default
        }
        
        proj4String += ' +no_defs';
        
        return proj4String || null;
    }
    
    return null;
}

// Transform GeoJSON coordinates from source CRS to target CRS
function transformGeoJSONCoordinates(geojson, sourceCRS, targetCRS) {
    if (!geojson || sourceCRS === targetCRS) {
        return geojson;
    }
    
    if (typeof proj4 === 'undefined') {
        throw new Error('proj4js library not loaded');
    }
    
    // Deep clone to avoid mutating original
    const transformed = JSON.parse(JSON.stringify(geojson));
    
    function transformCoordinates(coords) {
        if (Array.isArray(coords[0])) {
            // Array of coordinates
            return coords.map(coord => transformCoordinates(coord));
        } else {
            // Single coordinate [x, y] or [x, y, z]
            const [x, y, z] = coords;
            const transformed = proj4(sourceCRS, targetCRS, [x, y]);
            return z !== undefined ? [transformed[0], transformed[1], z] : transformed;
        }
    }
    
    function transformFeature(feature) {
        if (!feature.geometry || !feature.geometry.coordinates) {
            return feature;
        }
        
        const geom = feature.geometry;
        
        if (geom.type === 'Point') {
            geom.coordinates = transformCoordinates(geom.coordinates);
        } else if (geom.type === 'LineString' || geom.type === 'MultiPoint') {
            geom.coordinates = transformCoordinates(geom.coordinates);
        } else if (geom.type === 'Polygon' || geom.type === 'MultiLineString') {
            geom.coordinates = geom.coordinates.map(ring => transformCoordinates(ring));
        } else if (geom.type === 'MultiPolygon') {
            geom.coordinates = geom.coordinates.map(polygon => 
                polygon.map(ring => transformCoordinates(ring))
            );
        }
        
        return feature;
    }
    
    if (transformed.type === 'Feature') {
        transformFeature(transformed);
    } else if (transformed.type === 'FeatureCollection' && transformed.features) {
        transformed.features = transformed.features.map(transformFeature);
    } else if (transformed.type === 'GeometryCollection' && transformed.geometries) {
        transformed.geometries = transformed.geometries.map(geom => {
            const feature = { type: 'Feature', geometry: geom };
            transformFeature(feature);
            return feature.geometry;
        });
    }
    
    return transformed;
}

// Process imported GeoJSON (common function for all formats)
// Creates a new data layer instead of adding to annotations
async function processImportedGeoJSON(geojson) {
    if (window.annotationStorageModule && typeof window.annotationStorageModule.ensureSavedDataLayersLoaded === 'function') {
        await window.annotationStorageModule.ensureSavedDataLayersLoaded();
    }
    // Validate GeoJSON
    if (!geojson || !geojson.type) {
        appAlert('Invalid GeoJSON. The file must be a valid GeoJSON FeatureCollection or Feature.');
        return;
    }
    
    // Convert GeoJSON to annotations
    const importedAnnotations = convertGeoJSONToAnnotations(geojson);
    
    if (importedAnnotations.length === 0) {
        appAlert('No valid features found in the uploaded file.');
        return;
    }
    
    // Generate layer name from filename
    let layerName = 'Imported Data';
    if (currentImportFile) {
        const fileName = currentImportFile.name;
        // Remove extension
        layerName = fileName.replace(/\.(geojson|json|kml|kmz|zip|shp)$/i, '');
        // Add date if desired
        const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        layerName = `${layerName} - ${dateStr}`;
    }
    
    // Get savedDataLayers from storage module
    const savedDataLayers = window.annotationStorageModule?.savedDataLayers || [];
    
    // Get organization ID
    let organizationId = null;
    if (window.authModule && window.authModule.isAuthenticated()) {
        const user = window.authModule.getCurrentUser();
        organizationId = user.organizationId;
    }
    
    // Create new data layer
    const newLayer = {
        id: `data-layer-${Date.now()}`,
        name: layerName,
        originalName: layerName, // Store original name
        annotations: importedAnnotations,
        utilityType: '', // User can set this later
        createdAt: new Date().toISOString(),
        isVisible: true,
        listInLayerPanel: true,
        source: 'uploaded', // Mark as uploaded data layer
        organizationId: organizationId // Add organization ID
    };
    
    // Add to saved data layers
    savedDataLayers.push(newLayer);
    if (window.annotationStorageModule && window.annotationStorageModule.saveDataLayers) {
        window.annotationStorageModule.saveDataLayers();
    }
    
    // Render the data layer on the map
    if (window.layerManagerModule && window.layerManagerModule.renderDataLayer) {
        window.layerManagerModule.renderDataLayer(newLayer);
    }
    
    // Update layer control to show the new layer
    if (window.layerManagerModule && window.layerManagerModule.updateLayerControlOverlays) {
        window.layerManagerModule.updateLayerControlOverlays();
    }
    
    // Refresh data window if open
    if (window.refreshDataWindow) {
        window.refreshDataWindow();
    }
    
    appAlert(`Successfully imported ${importedAnnotations.length} feature(s) as data layer: "${layerName}"`);
    
    // Clear file reference
    currentImportFile = null;
}

// Convert GeoJSON to annotations format
function convertGeoJSONToAnnotations(geojson) {
    const converted = [];
    let features = [];
    
    // Handle different GeoJSON types
    if (geojson.type === 'FeatureCollection' && geojson.features) {
        features = geojson.features;
    } else if (geojson.type === 'Feature') {
        features = [geojson];
    } else {
        return converted;
    }
    
    features.forEach((feature, index) => {
        if (!feature.geometry) return;
        
        const geometry = feature.geometry;
        let annotation = null;
        
        // Determine annotation type based on geometry type
        if (geometry.type === 'Point') {
            annotation = {
                id: `imported-${Date.now()}-${index}`,
                type: 'point',
                name: feature.properties?.name || feature.properties?.title || `Imported Point ${index + 1}`,
                note: feature.properties?.description || feature.properties?.note || '',
                color: feature.properties?.color || 'var(--app-accent)',
                geometry: {
                    type: 'Point',
                    coordinates: geometry.coordinates // [lng, lat]
                },
                createdAt: new Date().toISOString()
            };
        } else if (geometry.type === 'LineString') {
            annotation = {
                id: `imported-${Date.now()}-${index}`,
                type: 'line',
                name: feature.properties?.name || feature.properties?.title || `Imported Line ${index + 1}`,
                note: feature.properties?.description || feature.properties?.note || '',
                color: feature.properties?.color || 'var(--app-accent)',
                geometry: {
                    type: 'LineString',
                    coordinates: geometry.coordinates // [[lng, lat], ...]
                },
                createdAt: new Date().toISOString()
            };
        } else if (geometry.type === 'Polygon') {
            annotation = {
                id: `imported-${Date.now()}-${index}`,
                type: 'polygon',
                name: feature.properties?.name || feature.properties?.title || `Imported Polygon ${index + 1}`,
                note: feature.properties?.description || feature.properties?.note || '',
                color: feature.properties?.color || 'var(--app-accent)',
                geometry: {
                    type: 'Polygon',
                    coordinates: geometry.coordinates // [[[lng, lat], ...], ...]
                },
                createdAt: new Date().toISOString()
            };
        }
        
        if (annotation) {
            converted.push(annotation);
        }
    });
    
    return converted;
}

// Export for use in other modules
window.fileImportModule = {
    initDataUpload,
    parseDataFile,
    parseGeoJSONFile,
    parseKMLFile,
    parseKMZFile,
    parseShapefile,
    processImportedGeoJSON,
    convertGeoJSONToAnnotations,
    transformGeoJSONCoordinates
};

// Make function globally available for HTML onclick handlers
window.initDataUpload = initDataUpload;

