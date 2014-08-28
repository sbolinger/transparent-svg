var http = require("http");
var path = require("path");
var util = require("util");
var url = require("url");
var fs = require("fs");
var PNG = require("pngjs").PNG;
var images = require("images");

var formidable = require("formidable");

var AWS = require("aws-sdk");
AWS.config.region = "us-east-1";

var port = (process.env.PORT || 8080);
//var serverUrl = "127.0.0.1";

var S3_BUCKET_NAME = "files.flite.com";
var S3_FILE_PATH = "ad/bolinger/";

var imagesPrepared = 0;

/*

	QUESTIONS

	1) Am I handling callback function in a 'kosher' way?

	2) Is attaching properties to the Object (e.g. 'fileName') an appropriate way to pass values to callback functions?

	3) For file upload handling, how do I not make the browser navigate to 'file-upload'?

	4) How to track asynchronous events (e.g. multiple calls to 'finalizeJpg') function without 'imagesPrepared' variable?
	
*/

http.createServer(function(req, res) {
	var filename = req.url || "/index.html";

	if (req.url === "/") filename = "/index.html";

	var ext = path.extname(filename);

	var localPath = __dirname + "/public";

	var validExtensions = {
		".html": "text/html",			
		".js": "application/javascript", 
		".css": "text/css",
		".txt": "text/plain",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".png": "image/png"
	};

	var isValidExt = validExtensions[ext];
	// Parse form data and upload file
	if (req.url == "/file-upload" && req.method.toLowerCase() == "post") {
		var form = new formidable.IncomingForm();
		
		// Set file upload directory
		form.uploadDir = "./";

		// Get form content and save any uploaded images into 'uploadDir'
		form.parse(req, function(err, fields, files) {
			
			// Call back function for after files have been saved
			if ("file" in files) {
				
				// A file was uploaded (and listed in 'files' Object)
				var file = files["file"];
				
				if(file.type === "image/png"){
					//console.log("Getting the pixels for:", file.name);
					
					// Get uploaded PNGs pixels for manipulation purposes
					var stream = fs.createReadStream(file.path);
					
					// Create modified original image
					var imagePipe = stream.pipe(new PNG({filterType: 4}));
					
					// Attach values needed down the line to Object to be included in callback
					imagePipe.fileName = file.name;
					imagePipe.compression = (fields.compression || 70);
					imagePipe.ver = "orig";
					imagePipe.res = res;
					
					imagePipe.on("parsed", modifyPixels);
					
					// Create mask image
					var imageMaskPipe = stream.pipe(new PNG({filterType: 4}));
					
					// Attach values needed down the line to Object to be included in callback
					imageMaskPipe.fileName = file.name;
					imageMaskPipe.compression = (fields.compression || 70);
					imageMaskPipe.ver = "mask";
					imageMaskPipe.res = res;
					
					imageMaskPipe.on("parsed", modifyPixels);
				}
				
	        } else {
				// No file sent
	        }
	
			// Delete original local file
			for (var f in files) {				
				fs.unlink(files[f].path);

			}
			
		});
		
	} else {
	
		if (isValidExt) {
		
			localPath += filename;
		
			fs.exists(localPath, function(exists) {
				if(exists) {				
					getFile(localPath, res, validExtensions[ext]);
				} else {				
					var contents = "<h1>Page not found</h1>";
				
					res.writeHead(404);
					res.end(contents);
				}
			});
 
		} else {
			console.log("Invalid file extension detected: " + ext);
		
			res.writeHead(404);
			res.end();
		}
	}
}).listen(port); //, serverUrl);

// Function that returns file requests
function getFile(localPath, res, mimeType) {
	fs.readFile(localPath, function(err, contents) {
		if(!err) {
			res.setHeader("Content-Length", contents.length);
			res.setHeader("Content-Type", mimeType);

			res.statusCode = 200;
			res.end(contents);
		} else {
			res.writeHead(500);
			res.end();
		}
	});
}

// Function called to modify PNG's pixels
function modifyPixels(){
	console.log("modifyPixels", this.height, this.width, this.fileName, this.ver, this.compression);
	
	// Update image pixels (remove semi-transparency and matt image to white background)
	for (var y = 0; y < this.height; y++) {
        for (var x = 0; x < this.width; x++) {
            var idx = (this.width * y + x) << 2;

			if(this.ver === "mask"){
				this.data[idx] = 0 + this.data[idx + 3];
	            this.data[idx + 1] = 0 + this.data[idx + 3];
	            this.data[idx + 2] = 0 + this.data[idx + 3];
			} else {
				if(this.data[idx + 3] == 0){
					this.data[idx] = 255;
		            this.data[idx + 1] = 255;
		            this.data[idx + 2] = 255;
				}
			}

            // Adjust semi-transparent pixels so that they are 100% opaque
            this.data[idx + 3] = 255;
        }
    }

	// Temporarily save modified PNG
	var tempFile = fs.createWriteStream("./" + this.ver + "_" + this.fileName);
	
	this.pack().pipe(tempFile);
	
	// Attach values needed down the line to Object to be included in callback
	tempFile.fileName = this.fileName;
	tempFile.compression = this.compression;
	tempFile.res = this.res;
	tempFile.width = this.width;
	tempFile.height = this.height;
	
	tempFile.on("close", finalizeJpg);
}

// Function to combine 2 PNGs into one JPG
function finalizeJpg(){
	console.log("finalizeJpg:", this.compression);
	
	imagesPrepared ++;
	
	if(imagesPrepared == 2) {
		imagesPrepared = 0;
		
		var newFileName = this.fileName.replace(".png", ".jpg");
		
		var compositeImage = images(this.width *2, this.height).fill(0xff, 0xff, 0xff);
		
		compositeImage.draw(images("./orig_" + this.fileName), 0, 0);
		
		compositeImage.draw(images("./mask_" + this.fileName), this.width, 0);
		
		compositeImage.save("./" + newFileName, {quality : this.compression});
		
		// Clean up the temp PNGs
		fs.unlink("./orig_" + this.fileName);
		fs.unlink("./mask_" + this.fileName);
		
		// Upload JPG to S3 bucket
		uploadFile(newFileName, this.width, this.height, this.res);
	}
}

// This function takes a remote file path and a local file path and uploads the file to an S3 bucket
// requires local S3 credentials (~/.aws/credentials)
function uploadFile(fileName, width, height, res) {
	//console.log("uploadFile:", fileName);
	
	var self = this;
	
	self.width = width;
	self.height = height;
	
	var s3 = new AWS.S3();
	
	var localFile = "./" + fileName;
	
	var remoteFilename = S3_FILE_PATH + fileName;
	
	// This is currently synchronous; probably should be async
	var fileBuffer = fs.readFileSync(localFile);
	var metaData = getContentTypeByFile(fileName);
  
	s3.putObject({
		ACL: "public-read",
		Bucket: S3_BUCKET_NAME,
		Key: remoteFilename,
		Body: fileBuffer,
		ContentType: metaData},
		
		function(error, response) {
			if(error){
				console.log("An error has occurred.");
				
				console.log(error);
			} else {
				console.log("uploaded file [" + localFile + "] to [" + remoteFilename + "] as [" + metaData + "], width:", self.width, "height:", self.height);
				
				// Determine weight of JPG
				var stats = fs.statSync(localFile)
				var fileSizeInBytes = stats["size"];
				
				var fileSizeInKilobytes = (Math.round(fileSizeInBytes / 100) / 10) + " KB";
				
				// Clean up the temp JPG
				fs.unlink("./" + fileName);
				
				// Send response to requesting page				
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.write(JSON.stringify({newFilePath: "http://" + S3_BUCKET_NAME + ".s3.amazonaws.com/" + remoteFilename, width: self.width, height: self.height, fileSize: fileSizeInKilobytes}));
				res.end();
			}
	});
}

// Utility function to determine file type
function getContentTypeByFile(fileName) {
	var rc = "application/octet-stream";
	var fn = fileName.toLowerCase();

	if (fn.indexOf(".html") >= 0) rc = "text/html";
	else if (fn.indexOf(".css") >= 0) rc = "text/css";
	else if (fn.indexOf(".json") >= 0) rc = "application/json";
	else if (fn.indexOf(".js") >= 0) rc = "application/x-javascript";
	else if (fn.indexOf(".png") >= 0) rc = "image/png";
	else if (fn.indexOf(".jpg") >= 0 || fn.indexOf(".jpeg") >= 0) rc = "image/jpg";

	return rc;
}