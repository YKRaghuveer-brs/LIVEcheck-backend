const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const axios = require('axios');
const cors = require('cors'); // Import CORS

dotenv.config(); // Load environment variables

const app = express();

// Enable CORS for requests from the React frontend on port 3000
app.use(cors({
  origin: '*',  // Allow only your React frontend
  methods: ['GET', 'POST'],  // Allow GET and POST requests
}));

app.use(express.json());

// MongoDB Connection
mongoose.connect('mongodb+srv://yelurikesavaraghuveer:Rg3ITSdF6n6A1s0O@live-events.vec6n.mongodb.net/LIVE_EVENTS', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Schema
const liveEventSchema = new mongoose.Schema({
  channel: { type: String, required: true },
  availableEvents: [
    {
      event_title: { type: String, required: true },
      live_status: { type: String, required: true },
      date: { type: String, required: true },
    }
  ]
});
const LiveEvent = mongoose.model('LiveEvent', liveEventSchema, 'live_events');

// YouTube API Key
const API_KEY = process.env.YOUTUBE_API_KEY;
async function getChannelId(channelUrl) {
  const regex = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:channel\/([^\/?]+)|@([^\/?]+)|user\/([^\/?]+)|c\/([^\/?]+))/;
  const match = channelUrl.match(regex);

  if (match) {
    const channelId = match[1];
    const username = match[2];
    const user = match[3];
    const customUrl = match[4];

    if (channelId) return channelId; // Direct channel ID

    try {
      const query = username || customUrl || user;
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${query}&key=${API_KEY}`;
      const response = await axios.get(searchUrl);

      if (response.data.items && response.data.items.length > 0) {
        return response.data.items[0].snippet.channelId;
      }
    } catch (error) {
      console.error(`Error fetching channel ID: ${error.message}`);
      throw new Error('Failed to fetch channel ID');
    }
  }

  throw new Error('Invalid or unrecognized channel URL');
}

async function fetchEvents(channelId) {
  const events = [];
  const types = ['live', 'upcoming']; // Fetch both live and upcoming events
  for (const eventType of types) {
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&eventType=${eventType}&key=${API_KEY}`;
    let nextPageToken = null;

    do {
      const response = await axios.get(nextPageToken ? `${url}&pageToken=${nextPageToken}` : url);
      const { items, nextPageToken: newToken } = response.data;

      for (const item of items) {
        const videoId = item.id.videoId;
        const videoDetailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${API_KEY}`;
        const videoResponse = await axios.get(videoDetailsUrl);
        const liveStreamingDetails = videoResponse.data.items[0]?.liveStreamingDetails || {};

        events.push({
          event_title: item.snippet.title,
          live_status: eventType === 'live' ? `Join now (Live: https://www.youtube.com/watch?v=${videoId})` : 'Scheduled',
          date: eventType === 'live' ? liveStreamingDetails.actualStartTime : liveStreamingDetails.scheduledStartTime,
        });
      }
      nextPageToken = newToken;
    } while (nextPageToken);
  }

  // Sort events by date (earliest first)
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

async function updateLiveEvents() {
  try {
    const channels = await LiveEvent.find();

    for (let channelDoc of channels) {
      const channelId = await getChannelId(channelDoc.channel);

      if (channelId) {
        const events = await fetchEvents(channelId);

        if (events.length > 0) {
          channelDoc.availableEvents = events; // Store all events
          await channelDoc.save();
          console.log(`Updated events for channel: ${channelDoc.channel} (ID: ${channelId})`);
        } else {
          console.log(`No events found for channel: ${channelDoc.channel}`);
        }
      } else {
        console.log(`Invalid channel link: ${channelDoc.channel}`);
      }
    }
  } catch (error) {
    console.error('Error updating live events:', error.message);
  }
}

app.post('/update-live-events', async (req, res) => {
  try {
    await updateLiveEvents();
    res.status(200).send('Live events updated successfully');
  } catch (error) {
    console.error('Error in /update-live-events endpoint:', error.message);
    res.status(500).send('Error updating live events');
  }
});

app.get('/live-events', async (req, res) => {
  try {
    const liveEvents = await LiveEvent.find();  // Get all documents from the live_events collection
    res.status(200).json(liveEvents);  // Send back the live events as a JSON response
  } catch (error) {
    console.error('Error fetching live events:', error.message);
    res.status(500).send('Error fetching live events');
  }
});

app.post('/update-channel-events', async (req, res) => {
  const { channelUrl } = req.body;

  if (!channelUrl) {
    return res.status(400).send('Channel URL is required');
  }

  try {
    const channelId = await getChannelId(channelUrl);

    if (!channelId) {
      return res.status(400).send('Invalid or unrecognized channel URL');
    }

    // Fetch events from the YouTube API
    const events = await fetchEvents(channelId);

    if (events.length === 0) {
      return res.status(404).send('No events found for this channel');
    }

    // Check if the channel already exists in the database
    let channelDoc = await LiveEvent.findOne({ channel: channelUrl });

    if (channelDoc) {
      // Update the existing document
      channelDoc.availableEvents = events;
      await channelDoc.save();
      console.log(`Updated events for channel: ${channelUrl} (ID: ${channelId})`);
      res.status(200).send('Channel events updated successfully');
    } else {
      // Create a new document for the channel
      channelDoc = new LiveEvent({
        channel: channelUrl,
        availableEvents: events,
      });
      await channelDoc.save();
      console.log(`Created a new document for channel: ${channelUrl} (ID: ${channelId})`);
      res.status(201).send('Channel events added successfully');
    }
  } catch (error) {
    console.error('Error updating or creating channel events:', error.message);
    res.status(500).send('An error occurred while processing the request');
  }
});

app.get('/channel-events', async (req, res) => {
  const { channelUrl } = req.query;  // Get the channel URL from the query parameters

  if (!channelUrl) {
    return res.status(400).send('Channel URL is required');
  }

  try {
    // Find the document corresponding to the given channel URL
    const channelDoc = await LiveEvent.findOne({ channel: channelUrl });

    if (!channelDoc) {
      return res.status(404).send('Channel not found');
    }

    // Return the document in JSON format
    res.status(200).json(channelDoc);
  } catch (error) {
    console.error('Error fetching channel events:', error.message);
    res.status(500).send('Error fetching channel events');
  }
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});