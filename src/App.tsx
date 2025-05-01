import { useState, useEffect } from 'react'
import './App.css'

// Define the strike interface
interface Station {
  sta: number;
  time: number;
  lat: number;
  lon: number;
  alt: number;
  status: number;
}

interface Strike {
  id: string;
  lat: number;
  lon: number;
  timestamp: number;
  time?: number;
  pol?: number;
  sig?: Station[] | number;
  region?: number;
  reg?: number;
  sta?: number;
  mds?: number;
  mcg?: number;
  alt?: number;
  status?: number;
  delay?: number;
  lonc?: number;
  latc?: number;
}

// Define the initial data interface
interface InitialData {
  type: string;
  strikes: Strike[];
}

function App() {
  const [strikes, setStrikes] = useState<Strike[]>([])
  const [connected, setConnected] = useState(false)
  const [lastUpdate, setLastUpdate] = useState('')

  useEffect(() => {
    // Connect to the WebSocket server
    const serverUrl = 'ws://localhost:3001'
    console.log('Connecting to WebSocket server at:', serverUrl)
    const ws = new WebSocket(serverUrl)
    
    ws.onopen = () => {
      console.log('Connected to server')
      setConnected(true)
    }

    ws.onclose = () => {
      console.log('Disconnected from server')
      setConnected(false)
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('Received data:', data)
        
        // Handle initial data with multiple strikes
        if (data.type === 'initial' && Array.isArray(data.strikes)) {
          console.log(`Received initial data with ${data.strikes.length} strikes`)
          setStrikes(data.strikes)
        }
        // Handle single strike updates
        else if (data.id && data.lat !== undefined && data.lon !== undefined) {
          console.log('Received new strike:', data)
          setStrikes(prev => [data, ...prev].slice(0, 100)) // Keep only latest 100
        }
        
        setLastUpdate(new Date().toLocaleTimeString())
      } catch (error) {
        console.error('Error parsing data:', error)
      }
    }

    return () => {
      console.log('Closing WebSocket connection')
      ws.close()
    }
  }, [])

  return (
    <div className="p-4">
      <h1 className="text-xl font-bold mb-4">Lightning Strike Data</h1>
      
      <div className="mb-4 flex gap-4">
        <div>
          <span className="mr-2">Server status:</span>
          <span className={connected ? "text-green-500 font-bold" : "text-red-500 font-bold"}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        
        <div>
          <span className="mr-2">Last update:</span>
          <span>{lastUpdate || "No updates yet"}</span>
        </div>
        
        <div>
          <span className="mr-2">Strikes received:</span>
          <span className="font-bold">{strikes.length}</span>
        </div>
      </div>
      
      <div className="overflow-auto max-h-[70vh]">
        <table className="min-w-full bg-white border border-gray-300">
          <thead>
            <tr>
              <th className="px-4 py-2 border">ID</th>
              <th className="px-4 py-2 border">Time</th>
              <th className="px-4 py-2 border">Latitude</th>
              <th className="px-4 py-2 border">Longitude</th>
              <th className="px-4 py-2 border">Polarity</th>
              <th className="px-4 py-2 border">Signal</th>
              <th className="px-4 py-2 border">Region</th>
            </tr>
          </thead>
          <tbody>
            {strikes.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-2 border text-center text-gray-500">
                  No data received yet
                </td>
              </tr>
            ) : (
              strikes.map(strike => (
                <tr key={strike.id}>
                  <td className="px-4 py-2 border">{strike.id.substring(0, 8)}...</td>
                  <td className="px-4 py-2 border">{new Date(strike.timestamp).toLocaleTimeString()}</td>
                  <td className="px-4 py-2 border">{strike.lat.toFixed(6)}</td>
                  <td className="px-4 py-2 border">{strike.lon.toFixed(6)}</td>
                  <td className="px-4 py-2 border">{strike.pol !== undefined ? strike.pol : 'N/A'}</td>
                  <td className="px-4 py-2 border">{strike.sig !== undefined ? Array.isArray(strike.sig) ? `${strike.sig.length} stations` : strike.sig : 'N/A'}</td>
                  <td className="px-4 py-2 border">{strike.region !== undefined ? strike.region : (strike.reg !== undefined ? strike.reg : 'N/A')}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default App
