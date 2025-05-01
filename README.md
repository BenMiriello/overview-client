# Lightning Client

A minimalistic React client for displaying real-time lightning strike data.

Currently only displays data in a table as it arrives.

Future versions will display data in a 3d globe visualization.

## How It Works

1. Connects to the Lightning Server via WebSocket
2. Receives lightning strike data in real-time
3. Displays strikes in a simple table format

## Usage

```
npm install
npm run dev
```

The client will connect to the server running on localhost:3001.
