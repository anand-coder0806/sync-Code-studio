const mongoose = require('mongoose');

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  try {
    const conn = await mongoose.connect(mongoUri);
    console.log(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('MongoDB reconnected');
    });

    mongoose.connection.on('error', (error) => {
      console.error(`MongoDB runtime error: ${error.message}`);
    });

    return conn;
  } catch (error) {
    console.error(`MongoDB connection failed: ${error.message}`);

    if (error.code === 'ECONNREFUSED') {
      console.error(
        'MongoDB is unreachable. Ensure the MongoDB service is running or set MONGO_URI to a reachable MongoDB/Atlas cluster URI.'
      );
    }

    throw error;
  }
};

module.exports = connectDB;
