const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    return {
      folder: 'omiye-helpdesk',
      resource_type: isImage ? 'image' : 'raw',
      public_id: Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'),
      // Make all files publicly accessible
      type: 'upload',
      access_mode: 'public',
    };
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = { cloudinary, upload };
