import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Fix for default markers in react-leaflet
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface Coordinate {
  lng: number;
  lat: number;
}

interface AIResponse {
  timestamp: string;
  message: string;
}

// Custom marker icons
const createCustomIcon = (color: string) => {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background-color: ${color}; width: 20px; height: 20px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });
};

const startIcon = createCustomIcon('#4CAF50');
const endIcon = createCustomIcon('#F44336');
const currentIcon = createCustomIcon('#2196F3');

// Component to center map on current coordinate
function MapUpdater({ currentCoordinate }: { currentCoordinate: Coordinate | null }) {
  const map = useMap();
  
  useEffect(() => {
    if (currentCoordinate) {
      map.setView([currentCoordinate.lat, currentCoordinate.lng], 15);
    }
  }, [currentCoordinate, map]);
  
  return null;
}

function App() {
  const [routeUrl, setRouteUrl] = useState('');
  const [walkingPace, setWalkingPace] = useState(20);
  const [isWalking, setIsWalking] = useState(false);
  const [coordinates, setCoordinates] = useState<Coordinate[]>([]);
  const [currentCoordinateIndex, setCurrentCoordinateIndex] = useState(0);
  const [aiResponses, setAiResponses] = useState<AIResponse[]>([]);
  const [currentCoordinate, setCurrentCoordinate] = useState<Coordinate | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]);
  const [mapZoom, setMapZoom] = useState(13);
  const [isSimulationActive, setIsSimulationActive] = useState(false);
  const [isProcessingRoute, setIsProcessingRoute] = useState(false);
  const [isValidUrl, setIsValidUrl] = useState(true);
  const walkingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const simulationActiveRef = useRef<boolean>(false);
  const [showCoordinates, setShowCoordinates] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isApiCallInProgress, setIsApiCallInProgress] = useState(false);
  const [lastProcessedIndex, setLastProcessedIndex] = useState(-1);
  const [currentPosition, setCurrentPosition] = useState<{ lng: number; lat: number } | null>(null);
  const [routeCoordinates, setRouteCoordinates] = useState<{ lng: number; lat: number }[]>([]);
  const [walkingSpeed, setWalkingSpeed] = useState(5.56); // 20 km/h in m/s
  const [currentIndex, setCurrentIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [urlValidation, setUrlValidation] = useState<'valid' | 'invalid' | 'processing' | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isWalkingRef = useRef<boolean>(false);
  const currentIndexRef = useRef<number>(0);
  const lastResponseRef = useRef<string>('');
  const isApiCallInProgressRef = useRef<boolean>(false);
  const lastProcessedIndexRef = useRef<number>(-1);

  // Extract coordinates from URL
  const extractCoordinatesFromUrl = async (url: string): Promise<Coordinate[]> => {
    try {
      // Check if it's a BRouter URL
      if (url.includes('brouter.damsy.net')) {
        const lonlatsMatch = url.match(/lonlats=([^&]+)/);
        if (lonlatsMatch) {
          const lonlats = lonlatsMatch[1];
          const coordPairs = lonlats.split(';');
          const coords: Coordinate[] = [];
          
          for (const pair of coordPairs) {
            const [lng, lat] = pair.split(',').map(Number);
            if (!isNaN(lng) && !isNaN(lat)) {
              coords.push({ lng, lat });
            }
          }
          
          if (coords.length >= 2) {
            console.log('Extracted BRouter coordinates:', coords);
            return coords;
          }
        }
        
        throw new Error('Could not extract coordinates from BRouter URL. Please make sure the URL contains lonlats parameter.');
      }
      
      throw new Error('Please use a BRouter URL. You can create routes at https://brouter.damsy.net/');
    } catch (error) {
      console.error('Error extracting coordinates:', error);
      throw error;
    }
  };

  // Get full route from OSRM API
  const getOSRMRoute = async (startCoord: Coordinate, endCoord: Coordinate): Promise<Coordinate[]> => {
    try {
      // OSRM API endpoint for routing
      const apiUrl = `https://router.project-osrm.org/route/v1/driving/${startCoord.lng},${startCoord.lat};${endCoord.lng},${endCoord.lat}?overview=full&geometries=geojson`
      
      console.log('Calling OSRM API:', apiUrl)
      
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      })
      
      if (!response.ok) {
        console.error('OSRM API response not ok:', response.status, response.statusText)
        throw new Error(`OSRM API error: ${response.status}`)
      }
      
      const data = await response.json()
      console.log('OSRM API response:', data)
      
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0]
        if (route.geometry && route.geometry.coordinates) {
          console.log('Found route coordinates:', route.geometry.coordinates.length)
          // Convert from [lng, lat] to {lng, lat} format
          return route.geometry.coordinates.map((coord: [number, number]) => ({
            lng: coord[0],
            lat: coord[1]
          }))
        }
      }
      
      throw new Error('No route found in OSRM API response')
    } catch (error) {
      console.error('Error getting OSRM route:', error)
      
      // Fallback: create intermediate points between start and end
      console.log('Using fallback route generation for OSRM')
      const fallbackCoords: Coordinate[] = []
      const numPoints = 15 // More points for better route simulation
      
      for (let i = 0; i <= numPoints; i++) {
        const progress = i / numPoints
        const lng = startCoord.lng + (endCoord.lng - startCoord.lng) * progress
        const lat = startCoord.lat + (endCoord.lat - startCoord.lat) * progress
        fallbackCoords.push({ lng, lat })
      }
      
      return fallbackCoords
    }
  }

  // Validate BRouter URL
  const validateBRouterUrl = (url: string): boolean => {
    return url.includes('brouter.damsy.net') && url.includes('lonlats=');
  };

  // Handle URL input change
  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const url = e.target.value;
    setRouteUrl(url);
    
    if (url.trim() === '') {
      setIsValidUrl(true);
      return;
    }
    
    const isValid = validateBRouterUrl(url);
    setIsValidUrl(isValid);
    
    // Auto-process if URL is valid
    if (isValid && !isProcessingRoute) {
      setTimeout(() => {
        processRouteUrl();
      }, 500); // Small delay to avoid processing while typing
    }
  };

  // Process route URL
  const processRouteUrl = async () => {
    if (!routeUrl.trim()) {
      return;
    }
    
    if (!validateBRouterUrl(routeUrl)) {
      return;
    }
    
    try {
      setIsProcessingRoute(true);
      console.log('Processing route URL:', routeUrl);
      
      const extractedCoords = await extractCoordinatesFromUrl(routeUrl);
      
      if (extractedCoords.length >= 2) {
        // Get full route from OSRM
        const fullRoute = await getOSRMRoute(extractedCoords[0], extractedCoords[extractedCoords.length - 1]);
        setCoordinates(fullRoute);
        
        // Update map center to the start point
        if (fullRoute.length > 0) {
          setMapCenter([fullRoute[0].lat, fullRoute[0].lng]);
          setMapZoom(15);
        }
        
        console.log('Route processed successfully:', fullRoute.length, 'coordinates');
      } else {
        setCoordinates(extractedCoords);
        if (extractedCoords.length > 0) {
          setMapCenter([extractedCoords[0].lat, extractedCoords[0].lng]);
          setMapZoom(15);
        }
      }
    } catch (error) {
      console.error('Error processing route URL:', error);
      setIsValidUrl(false);
    } finally {
      setIsProcessingRoute(false);
    }
  };

  // Calculate distance between two coordinates in meters
  const calculateDistance = (coord1: Coordinate, coord2: Coordinate): number => {
    const R = 6371e3; // Earth's radius in meters
    const φ1 = coord1.lat * Math.PI / 180;
    const φ2 = coord2.lat * Math.PI / 180;
    const Δφ = (coord2.lat - coord1.lat) * Math.PI / 180;
    const Δλ = (coord2.lng - coord1.lng) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  };

  // Find the closest coordinate from the coordinate list
  const findClosestCoordinate = (targetCoord: Coordinate): { index: number, coordinate: Coordinate } => {
    let closestIndex = 0;
    let closestDistance = Infinity;
    
    for (let i = 0; i < coordinates.length; i++) {
      const distance = calculateDistance(targetCoord, coordinates[i]);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = i;
      }
    }
    
    console.log(`Closest coordinate found: index ${closestIndex}, distance ${closestDistance} meters`);
    return { index: closestIndex, coordinate: coordinates[closestIndex] };
  };

  // Calculate where user would be after walking for given time
  const calculatePositionAfterTime = (startIndex: number, timeSeconds: number): { index: number, coordinate: Coordinate } => {
    if (coordinates.length === 0) return { index: 0, coordinate: coordinates[0] };
    
    const walkingSpeed = walkingPace / 3.6; // Convert km/h to m/s
    const distanceToTravel = walkingSpeed * timeSeconds; // Distance in meters
    
    console.log(`Walking speed: ${walkingSpeed} m/s, Distance to travel: ${distanceToTravel} meters`);
    console.log(`Starting from index: ${startIndex}`);
    
    // Calculate the total distance from start to current position
    let totalDistanceFromStart = 0;
    for (let i = 0; i < startIndex; i++) {
      totalDistanceFromStart += calculateDistance(coordinates[i], coordinates[i + 1]);
    }
    
    // Calculate target distance from start
    const targetDistanceFromStart = totalDistanceFromStart + distanceToTravel;
    
    console.log(`Total distance from start: ${totalDistanceFromStart} meters`);
    console.log(`Target distance from start: ${targetDistanceFromStart} meters`);
    
    // Find the coordinate closest to the target distance
    let accumulatedDistance = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const segmentDistance = calculateDistance(coordinates[i], coordinates[i + 1]);
      
      if (accumulatedDistance + segmentDistance >= targetDistanceFromStart) {
        // Interpolate between coordinates
        const remainingDistance = targetDistanceFromStart - accumulatedDistance;
        const progress = remainingDistance / segmentDistance;
        
        const coord1 = coordinates[i];
        const coord2 = coordinates[i + 1];
        const interpolatedCoord: Coordinate = {
          lng: coord1.lng + (coord2.lng - coord1.lng) * progress,
          lat: coord1.lat + (coord2.lat - coord1.lat) * progress
        };
        
        console.log(`Interpolated position: ${interpolatedCoord.lat}, ${interpolatedCoord.lng}`);
        
        // Find the closest coordinate from the list
        return findClosestCoordinate(interpolatedCoord);
      }
      
      accumulatedDistance += segmentDistance;
    }
    
    // If we've gone past all coordinates, return the last one
    return { index: coordinates.length - 1, coordinate: coordinates[coordinates.length - 1] };
  };

  // Send coordinate to AI with LangFlow API
  const sendCoordinateToAI = async (coord: Coordinate) => {
    // Prevent duplicate API calls
    if (isApiCallInProgressRef.current) {
      console.log('API call already in progress, skipping...');
      return;
    }
    
    isApiCallInProgressRef.current = true;
    
    try {
      console.log('Sending coordinate to LangFlow:', coord);
      
      const payload = {
        "input_value": `I am walking at ${walkingPace} km/h and currently at coordinates ${coord.lat}, ${coord.lng}. What should I know about this location or any interesting things around here?`,
        "output_type": "chat",
        "input_type": "chat",
        "session_id": "walkradio_user"
      };

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      };

      const response = await fetch('http://localhost:7860/api/v1/run/af5dbb48-ecb9-46ff-98cd-37ebd6d9b915', options);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log('LangFlow response:', data);

      let aiMessage = 'No response from AI';

      if (data.outputs && data.outputs.length > 0) {
        const output = data.outputs[0];
        
        if (output.outputs && output.outputs.length > 0) {
          const result = output.outputs[0];
          aiMessage = result.results.message.text;
        }
      }

      const newResponse: AIResponse = {
        timestamp: new Date().toLocaleTimeString(),
        message: aiMessage
      };
      
      // Check if this is a duplicate of the last response
      const isDuplicate = lastResponseRef.current === aiMessage;

      if (!isDuplicate) {
        lastResponseRef.current = aiMessage;
        setAiResponses(prev => [newResponse, ...prev]);
        console.log('AI response received:', newResponse.message);
      } else {
        console.log('Duplicate response detected, not adding to state');
      }
    } catch (error) {
      console.error('Error sending coordinate to LangFlow:', error);
      const errorResponse: AIResponse = {
        timestamp: new Date().toLocaleTimeString(),
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'} - Make sure LangFlow is running on localhost:7860`
      };
      setAiResponses(prev => [errorResponse, ...prev]);
    } finally {
      isApiCallInProgressRef.current = false;
    }
  };

  // Start walking simulation
  const startWalking = () => {
    if (coordinates.length === 0) {
      alert('Please enter a route URL first');
      return;
    }

    if (isSimulationActive) {
      console.log('Simulation already active, not starting new one');
      return;
    }

    // Clear any existing interval first
    if (walkingIntervalRef.current) {
      console.log('Clearing existing interval before creating new one');
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }

    setIsWalking(true);
    setIsSimulationActive(true);
    simulationActiveRef.current = true;
    setCurrentCoordinateIndex(0);
    setCurrentCoordinate(coordinates[0]);
    setAiResponses([]);

    // Send first coordinate immediately
    sendCoordinateToAI(coordinates[0]);

    // Set up interval for walking simulation - every 20 seconds
    const intervalMs = 20000; // 20 seconds
    console.log('Creating new interval with ID:', Date.now());
    walkingIntervalRef.current = setInterval(() => {
      console.log('Interval executing, simulation active:', simulationActiveRef.current);
      // Safety check: if simulation is not active, don't continue
      if (!simulationActiveRef.current) {
        console.log('Simulation not active, stopping execution');
        return;
      }
      
      setCurrentCoordinateIndex(prevIndex => {
        console.log(`=== UPDATE ===`);
        console.log('Current index before update:', prevIndex, 'Total coordinates:', coordinates.length);
        
        // Calculate where user would be after 20 seconds of walking
        const newPosition = calculatePositionAfterTime(prevIndex, 20);
        console.log('New position calculated:', newPosition);
        
        // Check if we've reached the end of the route
        if (newPosition.index >= coordinates.length - 1) {
          console.log('Reached end of route, stopping simulation');
          setIsWalking(false);
          setIsSimulationActive(false);
          simulationActiveRef.current = false;
          if (walkingIntervalRef.current) {
            clearInterval(walkingIntervalRef.current);
            walkingIntervalRef.current = null;
          }
          return coordinates.length - 1; // Stay at the last coordinate
        }
        
        console.log('Moving to new position:', newPosition.coordinate);
        setCurrentCoordinate(newPosition.coordinate);
        sendCoordinateToAI(newPosition.coordinate);
        return newPosition.index;
      });
    }, intervalMs);
  };

  // Stop walking simulation
  const stopWalking = () => {
    console.log('Stopping walking simulation');
    setIsWalking(false);
    setIsSimulationActive(false);
    simulationActiveRef.current = false;
    if (walkingIntervalRef.current) {
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (walkingIntervalRef.current) {
        clearInterval(walkingIntervalRef.current);
        walkingIntervalRef.current = null;
      }
      simulationActiveRef.current = false;
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>WalkRadio - AI Walking Companion</h1>
      </header>

      <div className="main-container">
        {/* Input Section */}
        <div className="input-section">
          <div className="input-group">
            <label htmlFor="routeUrl">Route URL (BRouter):</label>
            <div className="brouter-help">
              <p>Create your route at <a href="https://brouter.damsy.net/" target="_blank" rel="noopener noreferrer">BRouter Map</a></p>
              <small>1. Go to BRouter Map 2. Draw your route 3. Copy the URL 4. Paste it here</small>
            </div>
            <input
              id="routeUrl"
              type="text"
              value={routeUrl}
              onChange={handleUrlChange}
              onPaste={(e) => {
                const pastedText = e.clipboardData.getData('text');
                setRouteUrl(pastedText);
                
                // Validate and process immediately on paste
                const isValid = validateBRouterUrl(pastedText);
                setIsValidUrl(isValid);
                
                if (isValid && !isProcessingRoute) {
                  setTimeout(() => {
                    processRouteUrl();
                  }, 100);
                }
              }}
              placeholder="https://brouter.damsy.net/..."
              className={`route-input ${!isValidUrl && routeUrl.trim() !== '' ? 'invalid-url' : ''} ${isProcessingRoute ? 'processing' : ''}`}
            />
          </div>

          <div className="input-group">
            <label htmlFor="walkingPace">Walking Pace (km/h) - for AI context only:</label>
            <input
              id="walkingPace"
              type="number"
              value={walkingPace}
              onChange={(e) => setWalkingPace(Number(e.target.value))}
              min="0.1"
              max="50"
              step="0.1"
              className="pace-input"
            />
            <small>Prompts are sent every 20 seconds. Position is calculated based on your walking pace. Range: 0.1 - 50 km/h</small>
          </div>

          <div className="control-buttons">
            <button
              onClick={isWalking ? stopWalking : startWalking}
              className={`walk-btn ${isWalking ? 'stop' : 'start'}`}
            >
              {isWalking ? 'Stop Walking' : 'Start Walking'}
            </button>
          </div>
        </div>

        {/* Map Section */}
        <div className="map-section">
          <h3>Route Map</h3>
          <div className="map-container">
            <MapContainer
              center={mapCenter}
              zoom={mapZoom}
              style={{ height: '400px', width: '100%' }}
            >
              <TileLayer
                url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              />
              
              {/* Route line */}
              {coordinates.length > 1 && (
                <Polyline
                  positions={coordinates.map(coord => [coord.lat, coord.lng])}
                  color="blue"
                  weight={3}
                  opacity={0.7}
                />
              )}
              
              {/* Start marker */}
              {coordinates.length > 0 && (
                <Marker
                  position={[coordinates[0].lat, coordinates[0].lng]}
                  icon={startIcon}
                >
                  <Popup>Start Point</Popup>
                </Marker>
              )}
              
              {/* End marker */}
              {coordinates.length > 1 && (
                <Marker
                  position={[coordinates[coordinates.length - 1].lat, coordinates[coordinates.length - 1].lng]}
                  icon={endIcon}
                >
                  <Popup>End Point</Popup>
                </Marker>
              )}
              
              {/* Current position marker */}
              {currentCoordinate && (
                <Marker
                  position={[currentCoordinate.lat, currentCoordinate.lng]}
                  icon={currentIcon}
                >
                  <Popup>Current Position</Popup>
                </Marker>
              )}
              
              <MapUpdater currentCoordinate={currentCoordinate} />
            </MapContainer>
          </div>
          
          {/* Progress Bar */}
          <div className="progress-bar-section">
            <div className="progress-bar-container">
              <div 
                className="progress-bar-fill"
                style={{ 
                  width: `${coordinates.length > 0 ? Math.round(((currentCoordinateIndex + 1) / coordinates.length) * 100) : 0}%` 
                }}
              ></div>
            </div>
            <div className="progress-text">
              {coordinates.length > 0 ? `${Math.round(((currentCoordinateIndex + 1) / coordinates.length) * 100)}%` : '0%'}
            </div>
          </div>
        </div>

        {/* Coordinates Dropdown */}
        <div className="coordinates-dropdown">
          <button 
            className="dropdown-toggle"
            onClick={() => setShowCoordinates(!showCoordinates)}
          >
            Route Coordinates ({coordinates.length} points) {showCoordinates ? '▼' : '▶'}
          </button>
          {showCoordinates && (
            <div className="coordinates-content">
              {coordinates.length === 0 ? (
                <p>No coordinates loaded. Please enter a route URL.</p>
              ) : (
                <div className="coordinates-grid">
                  {coordinates.map((coord, index) => (
                    <div
                      key={index}
                      className={`coordinate-item ${index === currentCoordinateIndex ? 'current' : ''}`}
                    >
                      {index + 1}: {coord.lat.toFixed(6)}, {coord.lng.toFixed(6)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* LangFlow AI Responses */}
        <div className="ai-section">
          <h3>LangFlow AI Responses</h3>
          <div className="ai-responses">
            {aiResponses.length === 0 ? (
              <p className="no-responses">No AI responses yet. Start walking to see responses from LangFlow.</p>
            ) : (
              <div className="responses-container">
                {aiResponses.map((response, index) => (
                  <div key={`${response.timestamp}-${index}`} className="ai-response">
                    <div className="response-header">
                      <span className="timestamp">{response.timestamp}</span>
                    </div>
                    <div className="response-message">{response.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
