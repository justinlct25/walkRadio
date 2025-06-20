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

// Component to handle map clicks
function MapClickHandler({ 
  onMapClick, 
  isMapSelectionMode 
}: { 
  onMapClick: (event: L.LeafletMouseEvent) => void;
  isMapSelectionMode: boolean;
}) {
  const map = useMap();
  
  useEffect(() => {
    if (!isMapSelectionMode) return;
    
    const handleClick = (event: L.LeafletMouseEvent) => {
      onMapClick(event);
    };
    
    map.on('click', handleClick);
    
    return () => {
      map.off('click', handleClick);
    };
  }, [map, onMapClick, isMapSelectionMode]);
  
  return null;
}

// Walking state enum
type WalkingState = 'stopped' | 'walking' | 'paused';

function App() {
  const [routeUrl, setRouteUrl] = useState('');
  const [walkingPace, setWalkingPace] = useState(20);
  const [walkingState, setWalkingState] = useState<WalkingState>('stopped');
  const [coordinates, setCoordinates] = useState<Coordinate[]>([]);
  const [currentCoordinateIndex, setCurrentCoordinateIndex] = useState(0);
  const [aiResponses, setAiResponses] = useState<AIResponse[]>([]);
  const [currentCoordinate, setCurrentCoordinate] = useState<Coordinate | null>(null);
  const [mapCenter, setMapCenter] = useState<[number, number]>([51.505, -0.09]);
  const [mapZoom, setMapZoom] = useState(13);
  const [isProcessingRoute, setIsProcessingRoute] = useState(false);
  const [isValidUrl, setIsValidUrl] = useState(true);
  const [showCoordinates, setShowCoordinates] = useState(false);
  const [showWalkingStatus, setShowWalkingStatus] = useState(false);
  const [isMapSelectionMode, setIsMapSelectionMode] = useState(false);
  const [selectedStartPoint, setSelectedStartPoint] = useState<Coordinate | null>(null);
  const [selectedEndPoint, setSelectedEndPoint] = useState<Coordinate | null>(null);
  const [mapSelectionStep, setMapSelectionStep] = useState<'start' | 'end'>('start');
  const walkingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const coordinateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastResponseRef = useRef<string>('');
  const isApiCallInProgressRef = useRef<boolean>(false);
  const walkingStateRef = useRef<WalkingState>('stopped');
  const lastAiCallTimeRef = useRef<number>(0);
  const totalDistanceTraveledRef = useRef<number>(0);
  const currentPaceRef = useRef<number>(20);
  const [nextAiCallTime, setNextAiCallTime] = useState<number>(0);

  // Update ref when state changes
  useEffect(() => {
    walkingStateRef.current = walkingState;
  }, [walkingState]);

  // Update pace ref when walking pace changes
  useEffect(() => {
    currentPaceRef.current = walkingPace;
    console.log(`Walking pace updated to: ${walkingPace} km/h`);
  }, [walkingPace]);

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

  // Calculate bearing between two coordinates
  const calculateBearing = (coord1: Coordinate, coord2: Coordinate): number => {
    const Δλ = (coord2.lng - coord1.lng) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(coord2.lat * Math.PI / 180);
    const x = Math.cos(coord1.lat * Math.PI / 180) * Math.sin(coord2.lat * Math.PI / 180) -
              Math.sin(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) * Math.cos(Δλ);
    const bearing = Math.atan2(y, x);
    return (bearing * 180 / Math.PI + 360) % 360;
  };

  // Get direction name based on bearing
  const getDirectionName = (bearing: number): string => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(bearing / 45) % 8;
    return directions[index];
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
      
      // Determine walking context
      let walkingContext = '';
      let directionInfo = '';
      
      // Check if this is start, end, or during walking
      if (currentCoordinateIndex === 0) {
        walkingContext = 'START of route';
      } else if (currentCoordinateIndex >= coordinates.length - 1) {
        walkingContext = 'END of route';
      } else {
        walkingContext = 'WALKING along route';
        
        // Calculate direction and turning information
        const prevCoord = coordinates[currentCoordinateIndex - 1];
        const currentCoord = coord;
        const nextCoord = coordinates[currentCoordinateIndex + 1];
        
        // Calculate current direction (bearing)
        const currentBearing = calculateBearing(prevCoord, currentCoord);
        const nextBearing = calculateBearing(currentCoord, nextCoord);
        
        // Determine direction name
        const directionName = getDirectionName(currentBearing);
        
        // Check if turning
        const bearingDiff = Math.abs(nextBearing - currentBearing);
        let turningInfo = '';
        
        if (bearingDiff > 30) {
          const turnDirection = nextBearing > currentBearing ? 'right' : 'left';
          turningInfo = `, turning ${turnDirection}`;
        }
        
        directionInfo = `, heading ${directionName}${turningInfo}`;
      }
      
      const payload = {
        "input_value": `Current coordinates: ${coord.lat}, ${coord.lng}. Walking pace: ${currentPaceRef.current} km/h. Status: ${walkingContext}. Last direction: ${directionInfo}.`,
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

  // Update coordinate position every second based on current pace
  const updateCoordinatePosition = () => {
    if (walkingStateRef.current !== 'walking') {
      return;
    }

    // Calculate distance to travel in 1 second using the current pace ref
    const walkingSpeed = currentPaceRef.current / 3.6; // Convert km/h to m/s
    const distanceThisSecond = walkingSpeed; // Distance in meters per second
    
    // Add to total distance traveled
    totalDistanceTraveledRef.current += distanceThisSecond;
    
    console.log(`=== COORDINATE UPDATE ===`);
    console.log(`Current pace: ${currentPaceRef.current} km/h, Walking speed: ${walkingSpeed} m/s, Distance this second: ${distanceThisSecond} meters`);
    console.log(`Total distance traveled: ${totalDistanceTraveledRef.current} meters`);
    
    // Find the position along the route based on total distance traveled
    let accumulatedDistance = 0;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const segmentDistance = calculateDistance(coordinates[i], coordinates[i + 1]);
      
      if (accumulatedDistance + segmentDistance >= totalDistanceTraveledRef.current) {
        // Interpolate between coordinates
        const remainingDistance = totalDistanceTraveledRef.current - accumulatedDistance;
        const progress = remainingDistance / segmentDistance;
        
        const coord1 = coordinates[i];
        const coord2 = coordinates[i + 1];
        const interpolatedCoord: Coordinate = {
          lng: coord1.lng + (coord2.lng - coord1.lng) * progress,
          lat: coord1.lat + (coord2.lat - coord1.lat) * progress
        };
        
        console.log(`Interpolated position: ${interpolatedCoord.lat}, ${interpolatedCoord.lng} at segment ${i}`);
        setCurrentCoordinate(interpolatedCoord);
        setCurrentCoordinateIndex(i);
        
        // Check AI request with the current interpolated coordinate
        checkAndSendAiRequest(interpolatedCoord);
        return;
      }
      
      accumulatedDistance += segmentDistance;
    }
    
    // If we've gone past all coordinates, stop the simulation
    console.log('Reached end of route, stopping simulation');
    setWalkingState('stopped');
    setCurrentCoordinate(coordinates[coordinates.length - 1]);
    setCurrentCoordinateIndex(coordinates.length - 1);
    if (walkingIntervalRef.current) {
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }
    if (coordinateIntervalRef.current) {
      clearInterval(coordinateIntervalRef.current);
      coordinateIntervalRef.current = null;
    }
  };

  // Check if we should send AI request (every 20 seconds)
  const checkAndSendAiRequest = (currentCoord?: Coordinate) => {
    const currentTime = Date.now();
    const timeSinceLastAiCall = currentTime - lastAiCallTimeRef.current;
    
    // Use the passed coordinate or fall back to state
    const coordToUse = currentCoord || currentCoordinate;
    
    console.log(`AI check - Time since last call: ${timeSinceLastAiCall}ms, Current coordinate:`, coordToUse);
    
    if (timeSinceLastAiCall >= 20000 && coordToUse) { // 20 seconds
      console.log('Sending AI request - 20 seconds have passed');
      sendCoordinateToAI(coordToUse);
      lastAiCallTimeRef.current = currentTime;
      setNextAiCallTime(currentTime + 20000); // Set next AI call time
    } else if (timeSinceLastAiCall >= 20000 && !coordToUse) {
      console.log('20 seconds passed but no current coordinate available');
    } else {
      const remainingTime = 20000 - timeSinceLastAiCall;
      console.log(`Waiting for AI request - ${remainingTime}ms remaining`);
      setNextAiCallTime(lastAiCallTimeRef.current + 20000);
    }
  };

  // Start walking simulation
  const startWalking = () => {
    if (coordinates.length === 0) {
      alert('Please enter a route URL first');
      return;
    }

    if (walkingState === 'walking') {
      console.log('Already walking, not starting new simulation');
      return;
    }

    // Clear any existing intervals first
    if (walkingIntervalRef.current) {
      console.log('Clearing existing walking interval');
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }
    if (coordinateIntervalRef.current) {
      console.log('Clearing existing coordinate interval');
      clearInterval(coordinateIntervalRef.current);
      coordinateIntervalRef.current = null;
    }

    setWalkingState('walking');
    setCurrentCoordinateIndex(0);
    setCurrentCoordinate(coordinates[0]);
    setAiResponses([]);
    lastAiCallTimeRef.current = Date.now();
    totalDistanceTraveledRef.current = 0; // Reset total distance traveled
    setNextAiCallTime(Date.now() + 20000); // Set initial next AI call time

    // Send first coordinate immediately
    sendCoordinateToAI(coordinates[0]);

    // Set up interval for coordinate updates - every 1 second
    console.log('Creating coordinate update interval - every 1 second');
    coordinateIntervalRef.current = setInterval(() => {
      updateCoordinatePosition();
    }, 1000);
  };

  // Pause walking simulation
  const pauseWalking = () => {
    console.log('Pausing walking simulation');
    setWalkingState('paused');
    if (walkingIntervalRef.current) {
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }
    if (coordinateIntervalRef.current) {
      clearInterval(coordinateIntervalRef.current);
      coordinateIntervalRef.current = null;
    }
  };

  // Continue walking simulation
  const continueWalking = () => {
    console.log('Continuing walking simulation');
    if (walkingState !== 'paused') {
      console.log('Not paused, cannot continue');
      return;
    }

    setWalkingState('walking');
    
    // Set up interval for coordinate updates - every 1 second
    console.log('Creating coordinate update interval - every 1 second');
    coordinateIntervalRef.current = setInterval(() => {
      updateCoordinatePosition();
    }, 1000);
  };

  // Stop walking simulation
  const stopWalking = () => {
    console.log('Stopping walking simulation');
    setWalkingState('stopped');
    if (walkingIntervalRef.current) {
      clearInterval(walkingIntervalRef.current);
      walkingIntervalRef.current = null;
    }
    if (coordinateIntervalRef.current) {
      clearInterval(coordinateIntervalRef.current);
      coordinateIntervalRef.current = null;
    }
  };

  // Get button text and action based on current state
  const getButtonConfig = () => {
    switch (walkingState) {
      case 'stopped':
        return {
          primaryText: 'Start Walking',
          primaryAction: startWalking,
          primaryClass: 'start',
          secondaryText: null,
          secondaryAction: null,
          secondaryClass: null
        };
      case 'walking':
        return {
          primaryText: 'Pause',
          primaryAction: pauseWalking,
          primaryClass: 'pause',
          secondaryText: 'Stop',
          secondaryAction: stopWalking,
          secondaryClass: 'stop'
        };
      case 'paused':
        return {
          primaryText: 'Continue',
          primaryAction: continueWalking,
          primaryClass: 'continue',
          secondaryText: 'Stop',
          secondaryAction: stopWalking,
          secondaryClass: 'stop'
        };
      default:
        return {
          primaryText: 'Start Walking',
          primaryAction: startWalking,
          primaryClass: 'start',
          secondaryText: null,
          secondaryAction: null,
          secondaryClass: null
        };
    }
  };

  const buttonConfig = getButtonConfig();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (walkingIntervalRef.current) {
        clearInterval(walkingIntervalRef.current);
        walkingIntervalRef.current = null;
      }
      if (coordinateIntervalRef.current) {
        clearInterval(coordinateIntervalRef.current);
        coordinateIntervalRef.current = null;
      }
    };
  }, []);

  // Handle map click for point selection
  const handleMapClick = (event: L.LeafletMouseEvent) => {
    if (!isMapSelectionMode) return;
    
    const { lat, lng } = event.latlng;
    const clickedCoord: Coordinate = { lat, lng };
    
    if (mapSelectionStep === 'start') {
      setSelectedStartPoint(clickedCoord);
      setMapSelectionStep('end');
      console.log('Start point selected:', clickedCoord);
    } else {
      setSelectedEndPoint(clickedCoord);
      setMapSelectionStep('start');
      console.log('End point selected:', clickedCoord);
      
      // Generate route from selected points
      if (selectedStartPoint) {
        generateRouteFromPoints(selectedStartPoint, clickedCoord);
      }
    }
  };

  // Generate route from selected start and end points
  const generateRouteFromPoints = async (start: Coordinate, end: Coordinate) => {
    try {
      setIsProcessingRoute(true);
      console.log('Generating route from selected points:', start, 'to', end);
      
      // Get full route from OSRM
      const fullRoute = await getOSRMRoute(start, end);
      setCoordinates(fullRoute);
      
      // Update map center to the start point
      if (fullRoute.length > 0) {
        setMapCenter([fullRoute[0].lat, fullRoute[0].lng]);
        setMapZoom(15);
      }
      
      console.log('Route generated successfully:', fullRoute.length, 'coordinates');
    } catch (error) {
      console.error('Error generating route from points:', error);
    } finally {
      setIsProcessingRoute(false);
    }
  };

  // Reset map selection
  const resetMapSelection = () => {
    setSelectedStartPoint(null);
    setSelectedEndPoint(null);
    setMapSelectionStep('start');
    setIsMapSelectionMode(false);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>WalkRadio - AI Walking Companion</h1>
      </header>

      <div className="main-container">
        {/* Input Section */}
        <div className="input-section">
          {/* Route Selection Method */}
          <div className="route-method-selector">
            <div className="method-tabs">
              <button
                type="button"
                className={`method-tab ${!isMapSelectionMode ? 'active' : ''}`}
                onClick={() => {
                  setIsMapSelectionMode(false);
                  resetMapSelection();
                }}
              >
                Paste BRouter URL
              </button>
              <button
                type="button"
                className={`method-tab ${isMapSelectionMode ? 'active' : ''}`}
                onClick={() => {
                  setIsMapSelectionMode(true);
                  setMapSelectionStep('start');
                }}
              >
                Select on Map
              </button>
            </div>
          </div>

          {/* URL Input Method */}
          {!isMapSelectionMode && (
            <div className="input-group">
              <label htmlFor="routeUrl">BRouter Route URL:</label>
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
          )}

          {/* Map Selection Method */}
          {isMapSelectionMode && (
            <div className="map-selection-panel">
              <div className="selection-instructions">
                <h4>Select Your Route Points</h4>
                <div className="instruction-step">
                  <span className="step-number">1</span>
                  <span className="step-text">
                    {mapSelectionStep === 'start' 
                      ? 'Click on the map to select your start point' 
                      : 'Click on the map to select your end point'
                    }
                  </span>
                </div>
                {selectedStartPoint && (
                  <div className="selected-points">
                    <div className="point-item">
                      <span className="point-label start">Start Point:</span>
                      <span className="point-coords">
                        {selectedStartPoint.lat.toFixed(6)}, {selectedStartPoint.lng.toFixed(6)}
                      </span>
                    </div>
                    {selectedEndPoint && (
                      <div className="point-item">
                        <span className="point-label end">End Point:</span>
                        <span className="point-coords">
                          {selectedEndPoint.lat.toFixed(6)}, {selectedEndPoint.lng.toFixed(6)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {selectedStartPoint && selectedEndPoint && (
                  <div className="route-ready">
                    <p>Route ready! You can now start walking.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="input-group">
            <label htmlFor="walkingPace">Walking Pace (km/h):</label>
            <div className="pace-input-container">
              <button 
                type="button" 
                className="pace-btn pace-down"
                onClick={() => setWalkingPace(prev => Math.max(0.5, prev - 0.5))}
                disabled={walkingPace <= 0.5}
              >
                -
              </button>
              <input
                id="walkingPace"
                type="number"
                value={walkingPace}
                onChange={(e) => setWalkingPace(Number(e.target.value))}
                min="0.5"
                max="50"
                step="0.5"
                className="pace-input"
                placeholder="20.0"
              />
              <span className="pace-unit">km/h</span>
              <button 
                type="button" 
                className="pace-btn pace-up"
                onClick={() => setWalkingPace(prev => Math.min(50, prev + 0.5))}
                disabled={walkingPace >= 50}
              >
                +
              </button>
            </div>
          </div>

          {/* Walking Status Display */}
          <div className="walking-status-dropdown">
            <button 
              className="dropdown-toggle"
              onClick={() => setShowWalkingStatus(!showWalkingStatus)}
            >
              Walking Status {showWalkingStatus ? '▼' : '▶'}
            </button>
            {showWalkingStatus && (
              <div className="walking-status">
                <h3>Walking Status</h3>
                <div className="status-grid">
                  <div className="status-item">
                    <span className="status-label">State:</span>
                    <span className={`status-value status-${walkingState}`}>
                      {walkingState.charAt(0).toUpperCase() + walkingState.slice(1)}
                    </span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Current Pace:</span>
                    <span className="status-value">{walkingPace} km/h</span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">Coordinate Updates:</span>
                    <span className="status-value">Every 1 second</span>
                  </div>
                  <div className="status-item">
                    <span className="status-label">AI Updates:</span>
                    <span className="status-value">Every 20 seconds</span>
                  </div>
                  {walkingState === 'walking' && nextAiCallTime > 0 && (
                    <div className="status-item">
                      <span className="status-label">Next AI Call:</span>
                      <span className="status-value">
                        {Math.max(0, Math.ceil((nextAiCallTime - Date.now()) / 1000))}s
                      </span>
                    </div>
                  )}
                  {currentCoordinate && (
                    <div className="status-item">
                      <span className="status-label">Current Position:</span>
                      <span className="status-value">
                        {currentCoordinate.lat.toFixed(6)}, {currentCoordinate.lng.toFixed(6)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="control-buttons">
            <button
              onClick={buttonConfig.primaryAction}
              className={`walk-btn ${buttonConfig.primaryClass}`}
            >
              {buttonConfig.primaryText}
            </button>
            {buttonConfig.secondaryText && (
              <button
                onClick={buttonConfig.secondaryAction}
                className={`walk-btn ${buttonConfig.secondaryClass}`}
              >
                {buttonConfig.secondaryText}
              </button>
            )}
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
              
              {/* Selected start point marker */}
              {selectedStartPoint && (
                <Marker
                  position={[selectedStartPoint.lat, selectedStartPoint.lng]}
                  icon={startIcon}
                >
                  <Popup>Selected Start Point</Popup>
                </Marker>
              )}
              
              {/* Selected end point marker */}
              {selectedEndPoint && (
                <Marker
                  position={[selectedEndPoint.lat, selectedEndPoint.lng]}
                  icon={endIcon}
                >
                  <Popup>Selected End Point</Popup>
                </Marker>
              )}
              
              <MapClickHandler onMapClick={handleMapClick} isMapSelectionMode={isMapSelectionMode} />
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
