<?php 	
		if (isset($_POST['name'], $_POST['email'], $_POST['text'])) {

			$to = 'masslany@gmail.com';
			$subject = ' Message from ' . $_POST['name'] . ' (' . $_POST['email'] . ')';
			$text = $_POST['text'];
			$headers = "From: " . $_POST['email'] . "\r\n";

			$sent = mail($to, $subject, $text, $headers);

			if($sent){
				echo '<p> Message sent! </p> ';
			} else {
				echo '<p> Not sent! </p>';
			}
		}
?>
 